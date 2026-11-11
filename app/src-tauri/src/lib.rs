//! Carcasa de escritorio de falab.
//!
//! Responsabilidades (deliberadamente pocas, para que la app pese y consuma poco):
//!  1. Arrancar el motor local de Python como proceso hijo y cerrarlo al salir.
//!  2. Hacer de puente entre la interfaz y el motor (`peticion_motor`). El testigo de sesión
//!     vive solo aquí: la interfaz web nunca lo ve y ningún otro programa puede usar el motor.

use std::fs::{self, File};
use std::io::{BufRead, BufReader, Read};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tauri::ipc::Response;
use tauri::{Manager, RunEvent, State};

#[derive(Default)]
struct Motor {
    hijo: Mutex<Option<Child>>,
    puerto: Arc<Mutex<Option<u16>>>,
    error: Mutex<Option<String>>,
    testigo: String,
}

fn carpeta_de_datos() -> PathBuf {
    if let Ok(ruta) = std::env::var("FALAB_DIR") {
        return PathBuf::from(ruta);
    }
    let casa = std::env::var("HOME").or_else(|_| std::env::var("USERPROFILE")).unwrap_or_default();
    PathBuf::from(casa).join("Falab")
}

/// Localiza el intérprete de Python del entorno virtual del motor.
fn python_del_motor() -> Result<PathBuf, String> {
    if let Ok(ruta) = std::env::var("FALAB_PYTHON") {
        return Ok(PathBuf::from(ruta));
    }
    // Lo escribe scripts/instalar_mac.sh al terminar la instalación.
    let anotada = carpeta_de_datos().join("config").join("ruta_motor.txt");
    if let Ok(texto) = fs::read_to_string(&anotada) {
        let ruta = PathBuf::from(texto.trim());
        if ruta.exists() {
            return Ok(ruta);
        }
    }
    // En desarrollo: el entorno virtual está junto al código.
    let desarrollo = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../motor/.venv/bin/python");
    if desarrollo.exists() {
        return Ok(desarrollo);
    }
    Err(format!(
        "No se encontró el motor de falab. Ejecuta scripts/instalar_mac.sh (se esperaba la ruta en {}).",
        anotada.display()
    ))
}

fn arrancar_motor(motor: &Motor) -> Result<(), String> {
    let python = python_del_motor()?;
    let datos = carpeta_de_datos();
    fs::create_dir_all(&datos).map_err(|e| e.to_string())?;
    let registro = File::create(datos.join("motor.log")).map_err(|e| e.to_string())?;
    // Las apps gráficas de macOS no heredan el PATH de la terminal: sin esto no se
    // encontrarían ffmpeg ni rubberband instalados con Homebrew.
    let ruta_sistema = format!(
        "/opt/homebrew/bin:/usr/local/bin:{}",
        std::env::var("PATH").unwrap_or_else(|_| "/usr/bin:/bin".into())
    );
    let mut hijo = Command::new(&python)
        .args(["-m", "falab_motor"])
        .env("FALAB_TOKEN", &motor.testigo)
        .env("PATH", ruta_sistema)
        .env("PYTHONUNBUFFERED", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::from(registro))
        .spawn()
        .map_err(|e| format!("No se pudo arrancar el motor ({}): {e}", python.display()))?;

    // El motor anuncia por su salida estándar en qué puerto escucha.
    let salida = hijo.stdout.take().ok_or("El motor no tiene salida estándar.")?;
    let puerto = Arc::clone(&motor.puerto);
    std::thread::spawn(move || {
        for linea in BufReader::new(salida).lines().map_while(Result::ok) {
            if let Some(texto) = linea.strip_prefix("FALAB_MOTOR_LISTO puerto=") {
                if let Ok(numero) = texto.trim().parse::<u16>() {
                    *puerto.lock().unwrap() = Some(numero);
                }
            }
        }
    });
    *motor.hijo.lock().unwrap() = Some(hijo);
    Ok(())
}

/// Reenvía una petición de la interfaz al motor local y devuelve el cuerpo en binario.
#[tauri::command]
async fn peticion_motor(
    metodo: String,
    ruta: String,
    cuerpo: Option<String>,
    motor: State<'_, Motor>,
) -> Result<Response, String> {
    let error_de_arranque = motor.error.lock().unwrap().clone();
    if let Some(error) = error_de_arranque {
        return Err(error);
    }
    if !ruta.starts_with('/') {
        return Err("Ruta no válida.".into());
    }
    // El motor tarda unos segundos en arrancar la primera vez (carga de bibliotecas).
    let limite = Instant::now() + Duration::from_secs(60);
    let puerto = loop {
        let anunciado = *motor.puerto.lock().unwrap();
        if let Some(puerto) = anunciado {
            break puerto;
        }
        if Instant::now() > limite {
            return Err("El motor no respondió al arrancar. Revisa ~/Falab/motor.log.".into());
        }
        tokio_dormir(Duration::from_millis(150)).await;
    };
    let url = format!("http://127.0.0.1:{puerto}{ruta}");
    let testigo = motor.testigo.clone();

    tauri::async_runtime::spawn_blocking(move || -> Result<Vec<u8>, String> {
        let agente = ureq::AgentBuilder::new().timeout_connect(Duration::from_secs(5)).build();
        let peticion = agente.request(&metodo, &url).set("X-Falab-Token", &testigo);
        let respuesta = match cuerpo {
            Some(texto) => peticion.set("Content-Type", "application/json").send_string(&texto),
            None => peticion.call(),
        };
        match respuesta {
            Ok(respuesta) => {
                let mut datos = Vec::new();
                respuesta.into_reader().read_to_end(&mut datos).map_err(|e| e.to_string())?;
                Ok(datos)
            }
            Err(ureq::Error::Status(codigo, respuesta)) => {
                let texto = respuesta.into_string().unwrap_or_default();
                let detalle = serde_json::from_str::<serde_json::Value>(&texto)
                    .ok()
                    .and_then(|v| v.get("detail").and_then(|d| d.as_str()).map(String::from))
                    .unwrap_or_else(|| format!("Error {codigo}"));
                Err(detalle)
            }
            Err(error) => Err(format!("No se pudo contactar con el motor: {error}")),
        }
    })
    .await
    .map_err(|e| e.to_string())?
    .map(Response::new)
}

/// Espera sin bloquear el hilo de la interfaz.
async fn tokio_dormir(duracion: Duration) {
    let _ = tauri::async_runtime::spawn_blocking(move || std::thread::sleep(duracion)).await;
}

pub fn ejecutar() {
    let motor = Motor {
        testigo: format!("{}{}", uuid::Uuid::new_v4().simple(), uuid::Uuid::new_v4().simple()),
        ..Default::default()
    };
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(motor)
        .setup(|app| {
            let motor = app.state::<Motor>();
            if let Err(error) = arrancar_motor(&motor) {
                // No se aborta: la interfaz muestra el error y cómo resolverlo.
                *motor.error.lock().unwrap() = Some(error);
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![peticion_motor])
        .build(tauri::generate_context!())
        .expect("no se pudo iniciar falab")
        .run(|app, evento| {
            if let RunEvent::Exit = evento {
                if let Some(mut hijo) = app.state::<Motor>().hijo.lock().unwrap().take() {
                    let _ = hijo.kill();
                    let _ = hijo.wait();
                }
            }
        });
}
