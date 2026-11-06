import type { Celda, Hoja } from '../../xlsx';
import { BODEGAS, type EstadoRot, type ProductoRot } from './mappers';
import type { InformeRot } from './consulta';

/** Excel de la rotación (mismo contenido que la vista). Funciones puras. */

export const ESTADO_TEXTO: Record<EstadoRot, string> = {
  agotado: 'Agotado',
  por_agotarse: 'Por agotarse',
  normal: 'Normal',
  sobrestock: 'Sobrestock',
  sin_movimiento: 'Sin movimiento',
  sin_existencia: 'Sin existencia',
};

export const nombreBodega = (b: string) => (b === 'todas' ? 'Todas las bodegas' : `Bodega ${b} ${BODEGAS[b] ?? ''}`.trim());

export function hojasRotacion(inf: InformeRot, productos: ProductoRot[], proveedor: string | null): Hoja[] {
  const titulo: Celda[][] = [
    ['JOTAGRO DISTRIBUCIONES ESPECIALIZADAS S.A.S.'],
    [`ROTACIÓN DE INVENTARIO · ${nombreBodega(inf.bodega)}${proveedor ? ` · ${proveedor}` : ''}`],
    [`PERIODO ${inf.desde} A ${inf.hasta} (${inf.dias} días) · sugerido para cubrir ${inf.diasObjetivo} días`],
    [inf.existenciasTomadasEn ? `Existencia actual tomada de HGI el ${inf.existenciasTomadasEn.slice(0, 16).replace('T', ' ')} UTC` : ''],
    [],
  ];
  const encabezado: Celda[] = [
    'CÓDIGO', 'PRODUCTO', 'PROVEEDOR', 'INICIAL', 'ENTRADAS', 'COMPRAS', 'SALIDAS', 'VENTAS NETAS', 'FINAL',
    'DÍAS EN INVENTARIO', 'ROTACIÓN (VECES)', 'EXISTENCIA ACTUAL', 'COSTO UNITARIO', 'VALOR EXISTENCIA',
    'VENTA DIARIA', 'COBERTURA (DÍAS)', 'SUGERIDO COMPRA', 'ESTADO',
  ];
  const filas: Celda[][] = [...titulo, encabezado];
  for (const p of productos) {
    filas.push([
      p.codigo, p.nombre, p.nombreProveedor, p.inicial, p.entradas, p.compras, p.salidas, p.ventasNetas, p.final,
      p.diasInventario, p.rotacion, p.existencia, p.costoUnitario, p.valorExistencia, p.ventaDiaria, p.cobertura,
      p.sugerido, ESTADO_TEXTO[p.estado],
    ]);
  }
  const s = (k: keyof ProductoRot) => productos.reduce((a, p) => a + (Number(p[k]) || 0), 0);
  filas.push([], [null, 'TOTAL', null, s('inicial'), s('entradas'), s('compras'), s('salidas'), s('ventasNetas'), s('final'),
    null, null, s('existencia'), null, s('valorExistencia'), null, null, s('sugerido')]);

  const prov: Celda[][] = [
    ...titulo,
    ['PROVEEDOR', 'NIT', 'PRODUCTOS', 'INICIAL', 'ENTRADAS', 'SALIDAS', 'FINAL', 'DÍAS EN INVENTARIO', 'VALOR EXISTENCIA',
      'AGOTADOS', 'POR AGOTARSE', 'SIN MOVIMIENTO', 'VALOR SIN MOVIMIENTO', 'VALOR SUGERIDO COMPRA'],
    ...inf.proveedores
      .filter((p) => proveedor === null || p.nombre === proveedor)
      .map((p) => [p.nombre, p.nit, p.productos, p.inicial, p.entradas, p.salidas, p.final, p.diasInventario,
        p.valorExistencia, p.agotados, p.porAgotarse, p.sinMovimiento, p.valorSinMovimiento, p.valorSugerido]),
  ];

  return [
    { nombre: 'Productos', filas, anchos: [11, 52, 34, 9, 10, 10, 9, 12, 9, 12, 11, 12, 13, 15, 11, 12, 13, 14] },
    { nombre: 'Proveedores', filas: prov, anchos: [40, 12, 10, 10, 10, 10, 10, 12, 16, 10, 12, 12, 16, 18] },
  ];
}

export function nombreArchivoRot(inf: InformeRot, proveedor: string | null): string {
  const limpio = (s: string) =>
    s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9 .-]/g, '').replace(/\s+/g, ' ').trim().slice(0, 50);
  const b = inf.bodega === 'todas' ? 'todas las bodegas' : `bodega ${inf.bodega}`;
  return `ROTACION ${limpio(proveedor ?? '') ? `${limpio(proveedor!)} ` : ''}${b} ${inf.desde} a ${inf.hasta}.xlsx`;
}
