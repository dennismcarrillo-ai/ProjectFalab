// Evita que en Windows se abra una consola junto a la ventana.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    falab_lib::ejecutar()
}
