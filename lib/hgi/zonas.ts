/**
 * Zonas comerciales por vendedor.
 *
 * El ERP no sirve para esto: `NombreZonaTercero` viene "GENERAL" en todas las
 * líneas (las zonas no están configuradas en HGINet). El cliente definió que
 * cada zona es la cartera de un vendedor, así que la zona de una línea de venta
 * se deriva de su `NombreVendedor`.
 *
 * La UI muestra SIEMPRE "Zona N", nunca el nombre del vendedor: el nombre sólo
 * vive aquí, como regla de match.
 *
 * Match por primer nombre + primer apellido, normalizado (sin tildes, sin
 * mayúsculas/minúsculas, espacios colapsados). Así "GERMÁN JARAMILLO" o
 * "German Jaramillo Ruiz" caen en la zona 5, pero una "ISABELLA RUIZ" nueva NO
 * se cuela en la zona 2: cae en "Sin zona" y se avisa por log.
 *
 * Nombres exactos que trae el ERP (hgi_ventas_mensual.por_vendedor, 2024-08 →
 * 2026-09): HUGO MORALES, ISABELLA ESCOBAR, JULIANA BARONA, SANTIAGO LOPEZ,
 * GERMAN JARAMILLO, KELLY JUAJINOY y el comodín GENERAL (sin vendedor asignado,
 * ~0,06 % de la venta de sep-2026), que es "Sin zona" por diseño.
 */

export const ZONA_SIN = 'Sin zona';
/** Consolidado de todas las zonas. Lo arma /api/gerencia, no se persiste. */
export const ZONA_TODAS = 'Todas las zonas';

const REGLAS: ReadonlyArray<{ zona: number; nombre: string; apellido: string }> = [
  { zona: 1, nombre: 'HUGO', apellido: 'MORALES' },
  { zona: 2, nombre: 'ISABELLA', apellido: 'ESCOBAR' },
  { zona: 3, nombre: 'JULIANA', apellido: 'BARONA' },
  { zona: 4, nombre: 'SANTIAGO', apellido: 'LOPEZ' },
  { zona: 5, nombre: 'GERMAN', apellido: 'JARAMILLO' },
  { zona: 6, nombre: 'KELLY', apellido: 'JUAJINOY' },
];

export const NUM_ZONAS = REGLAS.length;

/** Etiqueta visible de la zona n: "Zona 3". */
export const etiquetaZona = (n: number) => `Zona ${n}`;

/** Todas las etiquetas que puede producir `zonaDeVendedor`, en orden. */
export const ZONAS: readonly string[] = [...REGLAS.map((r) => etiquetaZona(r.zona)), ZONA_SIN];

/** Sin tildes, mayúsculas, espacios colapsados. */
export const normalizarNombre = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/\s+/g, ' ')
    .trim();

/**
 * Vendedores sin match ya avisados. El agregado corre sobre miles de líneas: sin
 * esto, un vendedor nuevo llenaría el log del cron con una línea por venta.
 */
const avisados = new Set<string>();

/**
 * Zona de un vendedor. Nunca lanza: sin match devuelve "Sin zona" y avisa UNA
 * vez por nombre y proceso.
 */
export function zonaDeVendedor(vendedor: string): string {
  const tokens = normalizarNombre(vendedor).split(' ');
  // Primer token = primer nombre; el apellido puede venir tras un segundo nombre.
  const regla = REGLAS.find((r) => tokens[0] === r.nombre && tokens.slice(1).includes(r.apellido));
  if (regla) return etiquetaZona(regla.zona);

  if (!avisados.has(vendedor)) {
    avisados.add(vendedor);
    console.warn(`[zonas] Vendedor sin zona asignada: ${JSON.stringify(vendedor)} → "${ZONA_SIN}"`);
  }
  return ZONA_SIN;
}

/** Orden de presentación: Zona 1..N y al final "Sin zona" (o cualquier otra). */
export function ordenZona(zona: string): number {
  const i = ZONAS.indexOf(zona);
  return i === -1 ? ZONAS.length : i;
}

/**
 * ¿Este por_zona ya está por vendedor? Las filas construidas antes de esta
 * regla agrupan por ciudad ("MEDELLIN", "ENVIGADO"…) y no se pueden mezclar
 * con las nuevas: hasta que el mes se reconstruya, cuenta como mes sin dato.
 */
export const esPorZonaVendedor = (zonas: Array<{ zona: string }>) => zonas.every((z) => ZONAS.includes(z.zona));
