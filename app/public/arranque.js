/*
 * Informe de errores a la vista. Se carga antes que la aplicación y está escrito en JavaScript
 * antiguo a propósito: debe funcionar también en el navegador que no consiga arrancar falab,
 * para que en un teléfono (donde no hay consola) se vea qué ha fallado.
 */
(function () {
  var vistos = {};
  var caja = null;

  function texto(error) {
    if (!error) return "Error desconocido";
    if (typeof error === "string") return error;
    var nombre = error.name && error.name !== "Error" ? error.name + ": " : "";
    return nombre + (error.message || String(error));
  }

  function informe(mensaje, detalle) {
    return [
      "falab · informe de error",
      mensaje,
      detalle || "",
      "Navegador: " + navigator.userAgent,
      "Pantalla: " + window.innerWidth + "×" + window.innerHeight,
      "Página: " + location.origin,
      "Contexto seguro: " + (window.isSecureContext ? "sí" : "no"),
      "AudioWorklet: " + (typeof AudioWorkletNode === "undefined" ? "no" : "sí"),
    ].join("\n");
  }

  function mostrar(mensaje, detalle) {
    if (vistos[mensaje]) return;
    vistos[mensaje] = true;
    if (!document.body) return;
    if (!caja) {
      caja = document.createElement("div");
      caja.setAttribute("role", "alert");
      caja.style.cssText =
        "position:fixed;left:8px;right:8px;bottom:8px;z-index:99999;max-height:60vh;overflow:auto;" +
        "background:#2a1215;color:#ffd9dc;border:1px solid #c0434d;border-radius:10px;padding:12px 14px;" +
        "font:13px/1.4 -apple-system,system-ui,sans-serif;box-shadow:0 8px 30px rgba(0,0,0,.6)";
      var titulo = document.createElement("strong");
      titulo.textContent = "Algo ha fallado en falab";
      caja.appendChild(titulo);
      var cerrar = document.createElement("button");
      cerrar.textContent = "Cerrar";
      cerrar.style.cssText = "float:right;margin-left:8px";
      cerrar.onclick = function () { caja.parentNode.removeChild(caja); caja = null; vistos = {}; };
      caja.insertBefore(cerrar, titulo);
      document.body.appendChild(caja);
    }
    var completo = informe(mensaje, detalle);
    var parrafo = document.createElement("pre");
    parrafo.style.cssText = "white-space:pre-wrap;word-break:break-word;margin:8px 0 6px;font:12px/1.35 ui-monospace,Menlo,monospace;user-select:text;-webkit-user-select:text";
    parrafo.textContent = completo;
    caja.appendChild(parrafo);
    var copiar = document.createElement("button");
    copiar.textContent = "Copiar informe";
    copiar.onclick = function () {
      try {
        navigator.clipboard.writeText(completo).then(function () { copiar.textContent = "Copiado"; });
      } catch (e) {
        copiar.textContent = "No se pudo copiar: haz una captura de pantalla";
      }
    };
    caja.appendChild(copiar);
  }

  window.falabInformarError = function (error, contexto) {
    mostrar((contexto ? contexto + ": " : "") + texto(error), error && error.stack ? String(error.stack).split("\n").slice(0, 6).join("\n") : "");
  };

  window.addEventListener("error", function (evento) {
    // Un recurso que no carga (guion, hoja de estilos) llega sin mensaje, con el elemento como destino.
    var destino = evento.target;
    if (destino && destino !== window && (destino.src || destino.href)) {
      if (destino.tagName === "SCRIPT" || destino.tagName === "LINK") mostrar("No se pudo cargar " + (destino.src || destino.href));
      return;
    }
    // ResizeObserver avisa así de algo inofensivo.
    if (/ResizeObserver/.test(evento.message || "")) return;
    var donde = evento.filename ? evento.filename.replace(location.origin, "") + ":" + evento.lineno + ":" + evento.colno : "";
    mostrar(evento.error ? texto(evento.error) : evento.message || "Error desconocido",
      (evento.error && evento.error.stack ? String(evento.error.stack).split("\n").slice(0, 6).join("\n") : donde));
  }, true);

  window.addEventListener("unhandledrejection", function (evento) {
    var motivo = evento.reason;
    if (motivo && motivo.name === "AbortError") return;
    window.falabInformarError(motivo);
  });

  // Si a los diez segundos la aplicación no ha pintado nada, el navegador no ha podido con ella.
  setTimeout(function () {
    var raiz = document.getElementById("raiz");
    if (raiz && !raiz.firstChild) {
      mostrar("La aplicación no ha llegado a arrancar en este navegador.",
        "Prueba a actualizar el sistema del teléfono o a abrir la página en Safari (iPhone) o Chrome (Android).");
    }
  }, 10000);
})();
