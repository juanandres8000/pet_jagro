import { NextResponse } from 'next/server';
import { readSnapshot } from '@/lib/hgi/snapshotStore';
import type { RecaudoLinea } from '@/lib/hgi/mappers/recaudo';
import type { CarteraResumen, DocProximo, VendedorCartera } from '@/lib/hgi/mappers/cartera';
import type { Cliente } from '@/lib/hgi/mappers/terceros';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

/**
 * Rendimiento por vendedor + comportamiento de pago + próximos vencimientos.
 *
 * Todo se agrega en el lambda: la vista no baja las 5.843 líneas de recaudo ni los
 * 2.813 documentos por vencer para agrupar en el browser.
 *
 * DOS MAGNITUDES QUE NO SE MEZCLAN Y POR QUÉ
 *  - `recaudado` es un FLUJO del periodo, del snapshot de recaudo (mes corriente).
 *  - `saldoAbierto` es una FOTO de hoy, del snapshot de cartera.
 * Van en bloques separados y etiquetados. Restar uno del otro no significa nada:
 * no son el saldo inicial y el final de la misma cuenta. La vista lo dice
 * explícitamente, igual que con los saldos a favor.
 *
 * El ranking sale de `cartera.resumen.porVendedor`, que agrega POR DOCUMENTO, no
 * de agrupar terceros: 23 terceros tienen documentos de más de un vendedor, así
 * que agrupar por tercero misatribuiría su saldo (ver mappers/cartera.ts).
 *
 * Las lecturas a Postgres van EN SERIE, nunca en Promise.all — ver CLAUDE.md
 * § "Trampas del pooler".
 */

const PAGE_SIZE_DEFAULT = 25;
const PAGE_SIZE_MAX = 100;

/** Buckets de mora. Distribución, no promedio: con un máximo de 1.248 días el
 *  promedio de 21 no describe nada. */
const MORA_BUCKETS = [
  { clave: 'antes', label: 'Pagó antes', test: (d: number) => d < 0 },
  { clave: 'alDia', label: 'Al día', test: (d: number) => d === 0 },
  { clave: '1-30', label: 'Mora 1–30 d', test: (d: number) => d >= 1 && d <= 30 },
  { clave: '31-90', label: 'Mora 31–90 d', test: (d: number) => d >= 31 && d <= 90 },
  { clave: '90+', label: 'Mora 90+ d', test: (d: number) => d > 90 },
] as const;

/** Ventanas de vencimiento. "Más de 30" se muestra, no se esconde. */
const VENTANAS = [
  { clave: '7', label: 'Próximos 7 días', hasta: 7 },
  { clave: '15', label: 'Próximos 15 días', hasta: 15 },
  { clave: '30', label: 'Próximos 30 días', hasta: 30 },
] as const;

const div = (a: number, b: number) => (b === 0 ? 0 : a / b);
const dias = (desde: string, hasta: string) =>
  Math.round((Date.parse(`${hasta}T00:00:00Z`) - Date.parse(`${desde}T00:00:00Z`)) / 86_400_000);

interface FilaVendedor {
  codigoVendedor: string;
  nombre: string;
  // Flujo del periodo (recaudo)
  recaudado: number;
  operaciones: number;
  tercerosRecaudo: number;
  ticketPromedio: number;
  ajustes: number;
  opsAjustes: number;
  // Foto de hoy (cartera)
  saldoAbierto: number;
  saldoVencido: number;
  docsAbiertos: number;
  tercerosCartera: number;
}

export async function GET(req: Request) {
  const sp = new URL(req.url).searchParams;
  const ventana = sp.get('proximos');
  const page = Math.max(1, Number(sp.get('page')) || 1);
  const pageSize = Math.min(PAGE_SIZE_MAX, Math.max(5, Number(sp.get('pageSize')) || PAGE_SIZE_DEFAULT));

  const avisos: string[] = [];

  try {
    // EN SERIE, no Promise.all: cliente postgres.js con max:1 contra el pooler.
    const snapRec = await readSnapshot<RecaudoLinea>('recaudo');
    const snapCar = await readSnapshot<unknown>('cartera');

    const lineas = snapRec?.data ?? [];
    const resumenCar = (snapCar?.sourceCounts as unknown as CarteraResumen | undefined) ?? undefined;
    const porVendedorCartera: VendedorCartera[] = resumenCar?.porVendedor ?? [];
    const proximos: DocProximo[] = resumenCar?.proximos ?? [];

    if (!snapRec) avisos.push('Snapshot de recaudo no disponible: el bloque de recaudo del periodo queda vacío.');
    if (!resumenCar) avisos.push('Snapshot de cartera no disponible: el saldo abierto y los vencimientos quedan vacíos.');
    if (snapCar && !resumenCar?.porVendedor) {
      avisos.push('El snapshot de cartera es anterior al ensanche por vendedor; se repuebla en el próximo cron.');
    }

    // ---- Nombres: código de vendedor → nombre, desde recaudo (misma fila) ----
    const nombreVendedor = new Map<string, string>();
    for (const l of lineas) {
      if (l.codigoVendedor && l.vendedor && !nombreVendedor.has(l.codigoVendedor)) {
        nombreVendedor.set(l.codigoVendedor, l.vendedor);
      }
    }

    // ---- Frente 1: recaudo agrupado por codigoVendedor ----
    const rec = new Map<
      string,
      { recaudado: number; ops: number; terceros: Set<string>; ajustes: number; opsAjustes: number }
    >();
    for (const l of lineas) {
      const k = l.codigoVendedor || '(sin vendedor)';
      let e = rec.get(k);
      if (!e) {
        e = { recaudado: 0, ops: 0, terceros: new Set<string>(), ajustes: 0, opsAjustes: 0 };
        rec.set(k, e);
      }
      // esRecaudo separa plata que entró de ajustes contra cartera. NO se suman
      // juntos: esa separación es la que sostiene el KPI de caja.
      if (l.esRecaudo) {
        e.recaudado += l.valor;
        e.ops += 1;
        if (l.codigoTercero) e.terceros.add(l.codigoTercero);
      } else {
        e.ajustes += l.valor;
        e.opsAjustes += 1;
      }
    }

    const car = new Map(porVendedorCartera.map((v) => [v.codigoVendedor, v]));
    const codigos = [...new Set([...rec.keys(), ...car.keys()])];

    const vendedores: FilaVendedor[] = codigos.map((cod) => {
      const r = rec.get(cod);
      const c = car.get(cod);
      const recaudado = r?.recaudado ?? 0;
      const ops = r?.ops ?? 0;
      return {
        codigoVendedor: cod,
        nombre: nombreVendedor.get(cod) ?? cod,
        recaudado,
        operaciones: ops,
        tercerosRecaudo: r?.terceros.size ?? 0,
        ticketPromedio: div(recaudado, ops),
        ajustes: r?.ajustes ?? 0,
        opsAjustes: r?.opsAjustes ?? 0,
        saldoAbierto: c?.saldoAbierto ?? 0,
        saldoVencido: c?.saldoVencido ?? 0,
        docsAbiertos: c?.docs ?? 0,
        tercerosCartera: c?.terceros ?? 0,
      };
    });

    // Fila de cierre: las partes deben sumar el todo, y así se ve.
    const totales = vendedores.reduce(
      (a, v) => ({
        recaudado: a.recaudado + v.recaudado,
        operaciones: a.operaciones + v.operaciones,
        ajustes: a.ajustes + v.ajustes,
        opsAjustes: a.opsAjustes + v.opsAjustes,
        saldoAbierto: a.saldoAbierto + v.saldoAbierto,
        saldoVencido: a.saldoVencido + v.saldoVencido,
        docsAbiertos: a.docsAbiertos + v.docsAbiertos,
      }),
      { recaudado: 0, operaciones: 0, ajustes: 0, opsAjustes: 0, saldoAbierto: 0, saldoVencido: 0, docsAbiertos: 0 },
    );

    // ---- Frente 2a: comportamiento de pago, DISTRIBUCIÓN ----
    const conteo = MORA_BUCKETS.map((b) => ({ clave: b.clave, label: b.label, operaciones: 0, valor: 0 }));
    let sinVencimiento = 0;
    let peor = { dias: 0, tercero: '', valor: 0 };
    // El promedio se calcula sólo para poder CONTRASTARLO con la distribución en
    // la vista, no como métrica principal: con una cola de 1.248 días la media no
    // describe el comportamiento. Nunca se hardcodea en el UI.
    let sumaMora = 0;
    let opsEnMora = 0;
    for (const l of lineas) {
      if (!l.esRecaudo) continue;
      if (!l.fechaVencimiento || !l.fechaPago) {
        sinVencimiento += 1;
        continue;
      }
      const d = dias(l.fechaVencimiento, l.fechaPago);
      const i = MORA_BUCKETS.findIndex((b) => b.test(d));
      if (i >= 0) {
        conteo[i].operaciones += 1;
        conteo[i].valor += l.valor;
      }
      if (d > 0) {
        sumaMora += d;
        opsEnMora += 1;
      }
      if (d > peor.dias) peor = { dias: d, tercero: l.tercero, valor: l.valor };
    }
    const totalComp = conteo.reduce(
      (a, b) => ({ operaciones: a.operaciones + b.operaciones, valor: a.valor + b.valor }),
      { operaciones: 0, valor: 0 },
    );

    // ---- Frente 2b: próximos vencimientos ----
    // Las ventanas son acumulativas (<=7, <=15, <=30) y "más de 30" cubre el
    // resto del horizonte: se muestra, no se esconde.
    const ventanas: Array<{ clave: string; label: string; docs: number; valor: number }> = VENTANAS.map((v) => {
      const sel = proximos.filter((p) => p.diasParaVencer <= v.hasta);
      return { clave: v.clave as string, label: v.label as string, docs: sel.length, valor: sel.reduce((a, p) => a + p.saldo, 0) };
    });
    const resto = proximos.filter((p) => p.diasParaVencer > 30);
    ventanas.push({
      clave: 'mas30',
      label: `Más de 30 días (hasta ${resumenCar?.horizonteProximosDias ?? 45})`,
      docs: resto.length,
      valor: resto.reduce((a, p) => a + p.saldo, 0),
    });

    const meta = {
      ok: true,
      periodo: (snapRec?.sourceCounts as { periodo?: unknown } | null)?.periodo ?? null,
      builtAt: {
        recaudo: snapRec?.builtAt.toISOString() ?? null,
        cartera: snapCar?.builtAt.toISOString() ?? null,
      },
      horizonteProximosDias: resumenCar?.horizonteProximosDias ?? null,
      avisos,
    };

    // ---- Detalle paginado de una ventana de vencimiento ----
    if (ventana) {
      // Nombres de tercero: clients cubre el 95,5%; recaudo aporta los que
      // clients no tiene (sólo trae tipos 1 y 7). Nunca se inventa un nombre:
      // sin match se muestra el código.
      const nombreTercero = new Map<string, string>();
      for (const l of lineas) if (l.codigoTercero && l.tercero) nombreTercero.set(l.codigoTercero, l.tercero);
      const snapCli = await readSnapshot<Cliente>('clients');
      for (const c of snapCli?.data ?? []) if (c.id && c.nombre) nombreTercero.set(c.id, c.nombre);

      const sel =
        ventana === 'mas30'
          ? proximos.filter((p) => p.diasParaVencer > 30)
          : proximos.filter((p) => p.diasParaVencer <= Number(ventana));
      const total = sel.length;
      const maxPage = Math.max(1, Math.ceil(total / pageSize));
      const pageSafe = Math.min(page, maxPage);

      return NextResponse.json({
        ...meta,
        ventana,
        detalle: {
          page: pageSafe,
          pageSize,
          total,
          valor: sel.reduce((a, p) => a + p.saldo, 0),
          filas: sel.slice((pageSafe - 1) * pageSize, pageSafe * pageSize).map((p) => ({
            ...p,
            nombreTercero: nombreTercero.get(p.codigoTercero) ?? p.codigoTercero,
            nombreVendedor: nombreVendedor.get(p.codigoVendedor) ?? p.codigoVendedor,
          })),
        },
      });
    }

    return NextResponse.json({
      ...meta,
      vendedores,
      totales,
      comportamiento: {
        buckets: conteo,
        total: totalComp,
        sinVencimiento,
        peor,
        moraPromedio: div(sumaMora, opsEnMora),
        opsEnMora,
      },
      proximos: { ventanas, totalDocs: proximos.length },
    });
  } catch (err) {
    const mensaje = (err as Error).message;
    console.error(`[vendedores] falló: ${mensaje}`);
    // Degradación: 200 con avisos, nunca un 500 que tumbe la vista.
    return NextResponse.json({
      ok: false,
      mensaje,
      vendedores: [],
      totales: null,
      comportamiento: null,
      proximos: null,
      avisos: [`No se pudo calcular el rendimiento por vendedor (${mensaje}).`],
    });
  }
}
