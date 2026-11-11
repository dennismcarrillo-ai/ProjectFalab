/** Iconos vectoriales en línea (sin dependencias). */
import type { ReactNode } from "react";

const Icono = ({ children, tamano = 16 }: { children: ReactNode; tamano?: number }) => (
  <svg width={tamano} height={tamano} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    {children}
  </svg>
);

export const IconoReproducir = () => <Icono tamano={18}><path d="M8 5v14l11-7z" /></Icono>;
export const IconoPausa = () => <Icono tamano={18}><path d="M6 5h4v14H6zM14 5h4v14h-4z" /></Icono>;
export const IconoDetener = () => <Icono><path d="M6 6h12v12H6z" /></Icono>;
export const IconoMetronomo = () => (
  <Icono><path d="M9 2h6l5 20H4L9 2zm1.6 2L7.4 17h9.2L13.4 4h-2.8zM11 7h2v7h-2z" /></Icono>
);
export const IconoBucle = () => (
  <Icono><path d="M7 7h10v3l4-4-4-4v3H5v6h2V7zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4z" /></Icono>
);
export const IconoIman = () => (
  <Icono><path d="M4 3h5v9a3 3 0 0 0 6 0V3h5v9a8 8 0 0 1-16 0V3zm2 2v3h1V5H6zm11 0v3h1V5h-1z" /></Icono>
);
export const IconoNube = () => (
  <Icono><path d="M19.4 10A7 7 0 0 0 6 8.3 5.5 5.5 0 0 0 6.5 19H19a4.5 4.5 0 0 0 .4-9z" /></Icono>
);
export const IconoExportar = () => (
  <Icono><path d="M12 3l5 5h-3v7h-4V8H7l5-5zM5 19h14v2H5z" /></Icono>
);
export const IconoCerrar = () => (
  <Icono><path d="M6.4 5L5 6.4 10.6 12 5 17.6 6.4 19 12 13.4 17.6 19 19 17.6 13.4 12 19 6.4 17.6 5 12 10.6z" /></Icono>
);
