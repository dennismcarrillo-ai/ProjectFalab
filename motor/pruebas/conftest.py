import pytest

from falab_motor import config


@pytest.fixture(autouse=True)
def carpeta_de_datos(tmp_path, monkeypatch):
    """Cada prueba usa su propia carpeta de datos temporal."""
    monkeypatch.setattr(config, "DIR_DATOS", tmp_path)
    monkeypatch.setattr(config, "DIR_PROYECTOS", tmp_path / "proyectos")
    monkeypatch.setattr(config, "DIR_CONFIG", tmp_path / "config")
    config.asegurar_carpetas()
    return tmp_path
