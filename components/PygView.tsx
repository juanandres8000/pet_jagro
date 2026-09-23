'use client';

import { Fragment, useEffect, useMemo, useState } from 'react';
import { PageHeader, SectionTitle, KpiCard, Card, Th, EmptyState, Badge } from '@/components/ui';
import { formatPrice, kpiMoney } from '@/lib/format';

/**
 * Vista P&G (estado de resultados) mensual.
 *
 * No calcula nada de negocio: todos los agregados llegan resueltos de /api/pyg,
 * que los lee de las vistas pyg_saldo_cuenta / pyg_mensual. Las reglas contables
 * —clase 4 = créditos − débitos, clases 5 y 6 = débitos − créditos, periodo 13
 * excluido— viven en migrations/008_pyg_vistas.sql.
 *
 * Lo único que se deriva aquí son los porcentajes de presentación (márgenes y
 * peso de cada gasto sobre ingresos) y las variaciones contra el MISMO mes del
 * año anterior, que llega resuelto en `comparativo` (null si no está completo).
 *
 * REGLA DURA: un mes que no está completo NO muestra cifras. El endpoint ya
 * filtra —sólo lista meses con ventana mensual ok— pero la vista vuelve a
 * comprobarlo con `completo`, porque enseñar el P&G de un mes a medio ingestar
 * es peor que no enseñar nada.
 */

const MESES_LARGO = [
  'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
  'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre',
];
const MESES_CORTO = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

/** 'YYYY-MM' → "junio 2026". */
const mesLargo = (mes: string) => {
  const [y, m] = mes.split('-');
  return `${MESES_LARGO[Number(m) - 1] ?? mes} ${y}`;
};
/** 'YYYY-MM' → "jun 26". */
const mesCorto = (mes: string) => {
  const [y, m] = mes.split('-');
  return `${MESES_CORTO[Number(m) - 1] ?? mes} ${y.slice(2)}`;
};
/** 'YYYY-MM' → "may 2025", para "vs may 2025". */
const mesVs = (mes: string) => {
  const [y, m] = mes.split('-');
  return `${MESES_CORTO[Number(m) - 1] ?? mes} ${y}`;
};

const pctFmt = (v: number) => `${(v * 100).toFixed(1)}%`;
/** Porcentaje sobre una base, tolerando base 0 (devuelve null, no Infinity). */
const ratio = (parte: number, base: number): number | null => (base === 0 ? null : parte / base);
const pctODash = (v: number | null) => (v === null ? '—' : pctFmt(v));

/** Variación relativa, o null si no hay base (sin comparativo o base 0). */
const varRel = (actual: number, anterior: number | null | undefined): number | null =>
  anterior === null || anterior === undefined || anterior === 0 ? null : (actual - anterior) / Math.abs(anterior);
const conSigno = (v: number, decimales = 1) => `${v >= 0 ? '+' : ''}${v.toFixed(decimales)}`;
const varFmt = (v: number | null) => (v === null ? '—' : `${conSigno(v * 100)}%`);

/** Delta de una KPI contra el año anterior: "+12.3% vs may 2025", o "— vs may 2025". */
function deltaVs(actual: number, anterior: number | null | undefined, vs: string): string {
  return `${varFmt(varRel(actual, anterior))} vs ${vs}`;
}
/** Delta de un margen, en puntos porcentuales. */
function deltaPp(actual: number | null, anterior: number | null, vs: string): string {
  if (actual === null || anterior === null) return `— vs ${vs}`;
  return `${conSigno((actual - anterior) * 100)} pp vs ${vs}`;
}

// ---- Tipos de la respuesta de /api/pyg ----

interface Ingresos {
  brutas: number;
  devolucionesDescuentos: number;
  operacionalNeto: number;
  noOperacional: number;
  total: number;
}
interface Costo {
  valor: number;
  esFallback: boolean;
  fuente: string;
  contable: number;
  aviso?: string;
}
interface Integridad {
  diasEsperados: number;
  diasIngestados: number;
  completo: boolean;
  cuadraPartidaDoble: boolean;
  diferencia: number;
  /** El route la enciende sólo con |débitos − créditos| ≥ 1.000 (debajo es redondeo). */
  alertaPartidaDoble: boolean;
  debitos: number;
  creditos: number;
}
interface Subcuenta {
  subcuenta: string;
  descripcion: string;
  saldo: number;
  lineas: number;
}
interface GrupoGasto {
  grupo: string;
  descripcion: string;
  saldo: number;
  subcuentas: Subcuenta[];
}
interface GastosResumen {
  total: number;
  admon: number;
  ventas: number;
  noOperacional: number;
}
interface MesListado {
  mes: string;
  ingresos: Ingresos;
  costo: Costo;
  gastos: GastosResumen;
  utilidadBruta: number;
  utilidadOperacional: number;
  resultado: number;
  integridad: Integridad;
}
/** Cifras completas de un mes: el pedido y, con la misma forma, su comparativo. */
interface CifrasMes {
  mes: string;
  ingresos: Ingresos;
  costo: Costo;
  gastos: GastosResumen & { porGrupo: GrupoGasto[] };
  utilidadBruta: number;
  utilidadOperacional: number;
  resultado: number;
  integridad: Integridad;
}
interface Listado {
  ok: boolean;
  count: number;
  meses: MesListado[];
  aviso?: string;
}
interface Detalle {
  ok: boolean;
  mes: string;
  completo: boolean;
  aviso?: string;
  ingresos?: Ingresos;
  costo?: Costo;
  gastos?: GastosResumen & { porGrupo: GrupoGasto[] };
  utilidadBruta?: number;
  utilidadOperacional?: number;
  resultado?: number;
  integridad?: Integridad;
  /** El mismo mes del año anterior; null si no está completo. */
  comparativo?: CifrasMes | null;
  mesComparativo?: string;
}

// ---- Gráfico de tendencia ----

/**
 * Barras agrupadas ingresos / costo / gastos por mes, con el resultado como
 * línea sobre el mismo eje. Mismo lenguaje visual que el gráfico de Gerencia:
 * divs con las clases del tema, sin librería (el proyecto no tiene ninguna).
 *
 * El resultado puede ser negativo, así que la escala se calcula sobre el máximo
 * ABSOLUTO de todas las series y el cero se dibuja donde corresponde, en vez de
 * recortar las barras negativas contra el suelo.
 */
function GraficoTendencia({ meses, alto = 200 }: { meses: MesListado[]; alto?: number }) {
  if (!meses.length) return <EmptyState title="Sin meses completos todavía" />;

  const valores = meses.flatMap((m) => [m.ingresos.total, m.costo.valor, m.gastos.total, m.resultado]);
  // La escala reparte el alto entre la zona positiva y la negativa EN PROPORCIÓN
  // a lo que cada una necesita. Un 50/50 fijo desperdiciaba media caja: el peor
  // resultado (−101 M) es el 4% de los ingresos del mejor mes (2.340 M).
  const maxPos = Math.max(0, ...valores.filter((v) => v > 0));
  const maxNeg = Math.max(0, ...valores.filter((v) => v < 0).map(Math.abs));
  const span = Math.max(1, maxPos + maxNeg);
  const altoPos = Math.round((maxPos / span) * alto);
  const escala = (v: number) => (Math.abs(v) / span) * alto;

  return (
    <div className="overflow-x-auto">
      <div className="relative px-4 pb-2 pt-6">
        {/* Línea de cero continua, no un segmento por columna. */}
        <div
          className="pointer-events-none absolute inset-x-4 border-t border-line-strong"
          style={{ top: 24 + altoPos }}
        />
        <div className="flex min-w-full items-stretch gap-3">
          {meses.map((m) => {
            const res = m.resultado;
            return (
              <div key={m.mes} className="flex flex-1 flex-col" style={{ minWidth: 64 }}>
                <div className="relative" style={{ height: alto }}>
                  <div className="flex items-end justify-center gap-1" style={{ height: altoPos }}>
                    <div
                      className="w-full max-w-[16px] rounded-t bg-accent-light"
                      style={{ height: Math.max(2, escala(m.ingresos.total)) }}
                      title={`Ingresos ${formatPrice(m.ingresos.total)}`}
                    />
                    <div
                      className="w-full max-w-[16px] rounded-t bg-accent"
                      style={{ height: Math.max(2, escala(m.costo.valor)) }}
                      title={`Costo ${formatPrice(m.costo.valor)}${m.costo.esFallback ? ' (estimado)' : ''}`}
                    />
                    <div
                      className="w-full max-w-[16px] rounded-t bg-warn"
                      style={{ height: Math.max(2, escala(m.gastos.total)) }}
                      title={`Gastos ${formatPrice(m.gastos.total)}`}
                    />
                  </div>
                  {/* Marcador de resultado, medido desde el cero. */}
                  <div
                    className="pointer-events-none absolute inset-x-0 flex justify-center"
                    style={{ top: res >= 0 ? altoPos - escala(res) - 3 : altoPos + escala(res) - 3 }}
                  >
                    <span
                      className={`h-1.5 w-1.5 rounded-full ring-2 ring-surface ${res >= 0 ? 'bg-ink' : 'bg-danger'}`}
                      title={`Resultado ${formatPrice(res)}`}
                    />
                  </div>
                </div>
                <div className="mt-1.5 text-center tabular text-[10px] text-ink-faint">{mesCorto(m.mes)}</div>
                <div
                  className={`text-center tabular text-[10px] font-medium ${res >= 0 ? 'text-ink-muted' : 'text-danger'}`}
                >
                  {Math.round(res / 1_000_000).toLocaleString('es-CO')} M
                </div>
              </div>
            );
          })}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-4 border-t border-line px-4 py-2 text-xs text-ink-muted">
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-2.5 rounded-sm bg-accent-light" /> Ingresos
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-2.5 rounded-sm bg-accent" /> Costo
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-2.5 rounded-sm bg-warn" /> Gastos
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-1.5 w-1.5 rounded-full bg-ink" /> Resultado
        </span>
      </div>
    </div>
  );
}

// ---- Cascada del estado de resultados ----

type FilaTono = 'normal' | 'sub' | 'subtotal' | 'total';

function FilaCascada({
  etiqueta,
  valor,
  base,
  valorAnt,
  tipo = 'normal',
  sangria = 0,
  extra,
  expandible,
  abierto,
  onToggle,
}: {
  etiqueta: string;
  valor: number;
  base: number;
  /** Mismo concepto en el año anterior. null = sin comparativo o concepto ausente. */
  valorAnt: number | null;
  tipo?: FilaTono;
  sangria?: number;
  extra?: React.ReactNode;
  expandible?: boolean;
  abierto?: boolean;
  onToggle?: () => void;
}) {
  const pct = ratio(valor, base);
  const clasesFila =
    tipo === 'total'
      ? 'border-t-2 border-line-strong bg-surface-muted font-semibold'
      : tipo === 'subtotal'
        ? 'border-t border-line-strong bg-cream/60 font-medium'
        : 'border-t border-line';
  const clasesValor =
    tipo === 'total'
      ? valor < 0
        ? 'text-danger'
        : 'text-ink'
      : tipo === 'sub'
        ? 'text-ink-muted'
        : 'text-ink';

  const Contenido = (
    <>
      <td className="px-4 py-2.5" style={{ paddingLeft: 16 + sangria * 20 }}>
        <span className={`inline-flex items-center gap-2 ${tipo === 'sub' ? 'text-ink-muted' : 'text-ink'}`}>
          {expandible && (
            <span className="tabular text-xs text-ink-faint">{abierto ? '▾' : '▸'}</span>
          )}
          {etiqueta}
          {extra}
        </span>
      </td>
      <td className={`tabular whitespace-nowrap px-4 py-2.5 text-right ${clasesValor}`}>{formatPrice(valor)}</td>
      <td className="tabular whitespace-nowrap px-4 py-2.5 text-right text-ink-faint">{pctODash(pct)}</td>
      <td className="tabular whitespace-nowrap border-l border-line px-4 py-2.5 text-right text-ink-muted">
        {valorAnt === null ? <span className="text-ink-faint">—</span> : formatPrice(valorAnt)}
      </td>
      <td className="tabular whitespace-nowrap px-4 py-2.5 text-right text-ink-muted">{varFmt(varRel(valor, valorAnt))}</td>
    </>
  );

  if (expandible) {
    return (
      <tr
        className={`${clasesFila} cursor-pointer hover:bg-surface-hover`}
        onClick={onToggle}
        aria-expanded={abierto}
      >
        {Contenido}
      </tr>
    );
  }
  return <tr className={clasesFila}>{Contenido}</tr>;
}

// ---- Vista ----

export default function PygView() {
  const [listado, setListado] = useState<Listado | null>(null);
  const [mes, setMes] = useState<string>('');
  const [detalle, setDetalle] = useState<Detalle | null>(null);
  const [loadingListado, setLoadingListado] = useState(true);
  const [loadingMes, setLoadingMes] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [abiertos, setAbiertos] = useState<Record<string, boolean>>({});

  // Listado: define qué meses son seleccionables y alimenta la tendencia.
  useEffect(() => {
    let vivo = true;
    setLoadingListado(true);
    fetch('/api/pyg')
      .then((r) => r.json())
      .then((d: Listado) => {
        if (!vivo) return;
        setListado(d);
        // Por defecto, el mes completo más reciente. El endpoint ya los devuelve
        // del más nuevo al más viejo.
        if (d.meses?.length) setMes((actual) => actual || d.meses[0].mes);
        setError(null);
      })
      .catch((e: Error) => vivo && setError(e.message))
      .finally(() => vivo && setLoadingListado(false));
    return () => {
      vivo = false;
    };
  }, []);

  // Detalle del mes seleccionado.
  useEffect(() => {
    if (!mes) return;
    let vivo = true;
    setLoadingMes(true);
    setAbiertos({});
    fetch(`/api/pyg?mes=${mes}`)
      .then((r) => r.json())
      .then((d: Detalle) => {
        if (!vivo) return;
        setDetalle(d);
        setError(null);
      })
      .catch((e: Error) => vivo && setError(e.message))
      .finally(() => vivo && setLoadingMes(false));
    return () => {
      vivo = false;
    };
  }, [mes]);

  const mesesDisponibles = listado?.meses ?? [];
  // Selector agrupado por año, del más reciente al más viejo (el listado ya
  // viene en ese orden).
  const porAnio = useMemo(() => {
    const m = new Map<string, MesListado[]>();
    for (const x of mesesDisponibles) {
      const y = x.mes.slice(0, 4);
      m.set(y, [...(m.get(y) ?? []), x]);
    }
    return [...m];
  }, [mesesDisponibles]);

  // Tendencia: del más viejo al más nuevo para que el eje lea de izquierda a derecha.
  const tendencia = useMemo(() => [...mesesDisponibles].reverse(), [mesesDisponibles]);

  const toggle = (g: string) => setAbiertos((a) => ({ ...a, [g]: !a[g] }));

  const completo = detalle?.completo === true;
  const ing = detalle?.ingresos;
  const costo = detalle?.costo;
  const gastos = detalle?.gastos;
  const integridad = detalle?.integridad;

  const margenBruto = ing && detalle?.utilidadBruta !== undefined
    ? ratio(detalle.utilidadBruta, ing.operacionalNeto)
    : null;
  const margenNeto = ing && detalle?.resultado !== undefined ? ratio(detalle.resultado, ing.total) : null;

  // Comparativo: el mismo mes del año anterior. null = no está completo, y
  // entonces cada cifra muestra "—" en vez de inventar una variación.
  const comp = detalle?.comparativo ?? null;
  const vs = detalle?.mesComparativo ? mesVs(detalle.mesComparativo) : 'año anterior';
  const margenBrutoAnt = comp ? ratio(comp.utilidadBruta, comp.ingresos.operacionalNeto) : null;
  const margenNetoAnt = comp ? ratio(comp.resultado, comp.ingresos.total) : null;
  // Mezclar costo contable y costo del Gerencial no es comparable (en abril-2026
  // el contable quedó 15 % por debajo): se avisa cuando las fuentes difieren.
  const costosMezclados = !!comp && !!costo && comp.costo.esFallback !== costo.esFallback;
  const grupoAnt = (g: string) => comp?.gastos.porGrupo.find((x) => x.grupo === g) ?? null;
  const subAnt = (g: string, sc: string) => grupoAnt(g)?.subcuentas.find((x) => x.subcuenta === sc) ?? null;
  const gruposOperacionales = new Set(['51', '52']);
  // Unión de grupos de los dos meses: un grupo que sólo tuvo movimiento el año
  // anterior aparece con 0 este mes, para que la columna comparativa sume.
  const grupos: GrupoGasto[] = [
    ...(gastos?.porGrupo ?? []),
    ...(comp?.gastos.porGrupo ?? [])
      .filter((g) => !gastos?.porGrupo.some((x) => x.grupo === g.grupo))
      .map((g) => ({ ...g, saldo: 0, subcuentas: [] })),
  ].sort((a, b) => a.grupo.localeCompare(b.grupo));

  return (
    <div className="space-y-8">
      <PageHeader
        title="P&G"
        subtitle={
          <>
            Estado de resultados mensual desde el movimiento contable del ERP.
            {loadingListado && <span className="block">Cargando meses disponibles…</span>}
            {error && <span className="block text-danger">No se pudo cargar: {error}</span>}
            {listado?.aviso && <span className="block text-warn">{listado.aviso}</span>}
          </>
        }
        actions={
          mesesDisponibles.length > 0 && (
            <select
              value={mes}
              onChange={(e) => setMes(e.target.value)}
              className="rounded border border-line bg-surface px-3 py-1.5 text-sm text-ink"
              aria-label="Mes"
            >
              {porAnio.map(([anio, meses]) => (
                <optgroup key={anio} label={anio}>
                  {meses.map((m) => (
                    <option key={m.mes} value={m.mes}>
                      {mesLargo(m.mes)}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          )
        }
      />

      {/* Sin ningún mes completo: el backfill todavía no llegó. */}
      {!loadingListado && !error && mesesDisponibles.length === 0 && (
        <Card>
          <EmptyState
            title="Todavía no hay ningún mes completo"
            hint="El P&G se publica sólo cuando el mes está ingestado entero. El backfill los va cubriendo de a uno."
          />
        </Card>
      )}

      {loadingMes && !detalle && mesesDisponibles.length > 0 && (
        <Card>
          <EmptyState title="Calculando el estado de resultados…" />
        </Card>
      )}

      {/* Mes incompleto: aviso, sin cifras. */}
      {detalle && !completo && (
        <Card className="border-warn/30 bg-warn-soft">
          <div className="px-4 py-6">
            <div className="font-medium text-warn">{mesLargo(detalle.mes)} no está completo</div>
            <p className="mt-1 text-sm text-ink-muted">
              {detalle.aviso ?? 'No se muestran cifras de un mes que no se ingestó entero.'}
            </p>
          </div>
        </Card>
      )}

      {completo && ing && costo && gastos && detalle && (
        <>
          {/* Partida doble descuadrada: la contabilidad del mes no cierra. El
              umbral de redondeo lo decide el route (alertaPartidaDoble). */}
          {integridad && integridad.alertaPartidaDoble && (
            <Card className="border-warn/30 bg-warn-soft">
              <div className="px-4 py-4">
                <div className="font-medium text-warn">La partida doble de {mesLargo(detalle.mes)} no cuadra</div>
                <p className="mt-1 text-sm text-ink-muted">
                  Débitos <span className="tabular">{formatPrice(integridad.debitos)}</span> contra créditos{' '}
                  <span className="tabular">{formatPrice(integridad.creditos)}</span> — diferencia{' '}
                  <span className="tabular font-medium">
                    {formatPrice(integridad.diferencia)}
                  </span>
                  . Las cifras de abajo salen igual del movimiento tal cual lo devuelve el ERP.
                </p>
              </div>
            </Card>
          )}

          {/* KPIs */}
          <section className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
            <KpiCard
              label="Ingresos totales"
              {...kpiMoney(ing.total)}
              delta={deltaVs(ing.total, comp?.ingresos.total, vs)}
            />
            <KpiCard
              label="Costo de ventas"
              {...kpiMoney(costo.valor)}
              delta={deltaVs(costo.valor, comp?.costo.valor, vs)}
              tone={costo.esFallback ? 'warn' : 'neutral'}
              hint={
                costo.esFallback
                  ? 'Costo estimado por facturación, pendiente cierre contable'
                  : 'Costo contable del asiento de cierre'
              }
            />
            <KpiCard
              label="Utilidad bruta"
              {...kpiMoney(detalle.utilidadBruta ?? 0)}
              delta={deltaVs(detalle.utilidadBruta ?? 0, comp?.utilidadBruta, vs)}
              tone={(detalle.utilidadBruta ?? 0) < 0 ? 'danger' : 'neutral'}
            />
            <KpiCard
              label="Margen bruto"
              value={pctODash(margenBruto)}
              delta={deltaPp(margenBruto, margenBrutoAnt, vs)}
              tone={margenBruto !== null && margenBruto < 0 ? 'danger' : 'neutral'}
              hint="Sobre ingresos operacionales netos"
            />
            <KpiCard
              label="Gastos totales"
              {...kpiMoney(gastos.total)}
              delta={deltaVs(gastos.total, comp?.gastos.total, vs)}
            />
            <KpiCard
              label="Resultado"
              {...kpiMoney(detalle.resultado ?? 0)}
              delta={deltaVs(detalle.resultado ?? 0, comp?.resultado, vs)}
              tone={(detalle.resultado ?? 0) < 0 ? 'danger' : 'accent'}
              hint={`Margen neto ${pctODash(margenNeto)} sobre ingresos totales · ${deltaPp(margenNeto, margenNetoAnt, vs)}`}
            />
          </section>

          {/* Comparativo: ausente, o con costos de fuentes distintas. */}
          {!comp && detalle.mesComparativo && (
            <p className="-mt-4 text-xs text-ink-faint">
              Sin comparativo: {mesLargo(detalle.mesComparativo)} no está construido (no tiene su mes contable completo
              cargado), así que las cifras del año anterior se muestran como —.
            </p>
          )}
          {costosMezclados && comp && (
            <p className="-mt-4 text-xs text-warn">
              ⚠ El costo de {mesLargo(detalle.mes)} es {costo.esFallback ? 'estimado por facturación' : 'contable'} y el
              de {mesLargo(comp.mes)} es {comp.costo.esFallback ? 'estimado por facturación' : 'contable'}: la variación
              de costo, utilidades y márgenes mezcla dos fuentes y no es del todo comparable.
            </p>
          )}

          {/* Aviso del costo estimado */}
          {costo.esFallback && (
            <Card className="border-warn/30">
              <div className="flex flex-wrap items-center gap-3 px-4 py-3">
                <Badge tone="warn">Costo estimado</Badge>
                <span className="text-sm text-ink-muted" title={costo.aviso}>
                  Costo estimado por facturación, pendiente cierre contable.
                </span>
                {costo.aviso && <span className="text-xs text-ink-faint">{costo.aviso}</span>}
              </div>
            </Card>
          )}

          {/* Cascada */}
          <section className="space-y-3">
            <SectionTitle>Estado de resultados · {mesLargo(detalle.mes)}</SectionTitle>
            <Card>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-surface-muted">
                    <tr>
                      <Th>Concepto</Th>
                      <Th align="right">{mesVs(detalle.mes)}</Th>
                      <Th align="right">% ingresos</Th>
                      <Th align="right" className="border-l border-line">
                        {vs}
                      </Th>
                      <Th align="right">Var %</Th>
                    </tr>
                  </thead>
                  <tbody>
                    <FilaCascada
                      etiqueta="Ventas brutas"
                      valor={ing.brutas}
                      base={ing.total}
                      valorAnt={comp ? comp.ingresos.brutas : null}
                    />
                    <FilaCascada
                      etiqueta="Devoluciones y descuentos"
                      valor={ing.devolucionesDescuentos}
                      base={ing.total}
                      valorAnt={comp ? comp.ingresos.devolucionesDescuentos : null}
                      tipo="sub"
                      sangria={1}
                    />
                    <FilaCascada
                      etiqueta="Ingreso operacional neto"
                      valor={ing.operacionalNeto}
                      base={ing.total}
                      valorAnt={comp ? comp.ingresos.operacionalNeto : null}
                      tipo="subtotal"
                    />
                    <FilaCascada
                      etiqueta="Ingreso no operacional"
                      valor={ing.noOperacional}
                      base={ing.total}
                      valorAnt={comp ? comp.ingresos.noOperacional : null}
                    />
                    <FilaCascada
                      etiqueta="Ingresos totales"
                      valor={ing.total}
                      base={ing.total}
                      valorAnt={comp ? comp.ingresos.total : null}
                      tipo="subtotal"
                    />
                    <FilaCascada
                      etiqueta="Costo de ventas"
                      valor={-costo.valor}
                      base={ing.total}
                      valorAnt={comp ? -comp.costo.valor : null}
                      extra={
                        <>
                          {costo.esFallback && <Badge tone="warn">estimado</Badge>}
                          {comp?.costo.esFallback && <Badge tone="warn">{vs} estimado</Badge>}
                        </>
                      }
                    />
                    <FilaCascada
                      etiqueta="Utilidad bruta"
                      valor={detalle.utilidadBruta ?? 0}
                      base={ing.total}
                      valorAnt={comp ? comp.utilidadBruta : null}
                      tipo="subtotal"
                    />

                    {/* Cada grupo va seguido INMEDIATAMENTE de sus subcuentas
                        cuando está abierto. Renderizarlas en un bloque aparte
                        las mandaba al final de la tabla, debajo del grupo 53. */}
                    {[
                      ...grupos.filter((g) => gruposOperacionales.has(g.grupo)),
                      null, // corte: utilidad operacional tras 51 y 52
                      ...grupos.filter((g) => !gruposOperacionales.has(g.grupo)),
                    ].map((g) =>
                      g === null ? (
                        <FilaCascada
                          key="__operacional__"
                          etiqueta="Utilidad operacional"
                          valor={detalle.utilidadOperacional ?? 0}
                          base={ing.total}
                          valorAnt={comp ? comp.utilidadOperacional : null}
                          tipo="subtotal"
                        />
                      ) : (
                        <Fragment key={g.grupo}>
                          <FilaCascada
                            etiqueta={`${g.grupo} · ${g.descripcion}`}
                            valor={-g.saldo}
                            base={ing.total}
                            valorAnt={comp ? -(grupoAnt(g.grupo)?.saldo ?? 0) : null}
                            expandible={g.subcuentas.length > 0}
                            abierto={!!abiertos[g.grupo]}
                            onToggle={() => toggle(g.grupo)}
                          />
                          {abiertos[g.grupo] &&
                            // Ya vienen ordenadas por saldo desc del endpoint; se
                            // reordena igual para no depender del orden del JSON.
                            [...g.subcuentas]
                              .sort((a, b) => b.saldo - a.saldo)
                              .map((s) => (
                                <FilaCascada
                                  key={`${g.grupo}-${s.subcuenta}`}
                                  etiqueta={`${s.subcuenta} · ${s.descripcion}`}
                                  valor={-s.saldo}
                                  base={ing.total}
                                  valorAnt={comp ? -(subAnt(g.grupo, s.subcuenta)?.saldo ?? 0) : null}
                                  tipo="sub"
                                  sangria={1}
                                />
                              ))}
                        </Fragment>
                      ),
                    )}

                    <FilaCascada
                      etiqueta="Gastos totales"
                      valor={-gastos.total}
                      base={ing.total}
                      valorAnt={comp ? -comp.gastos.total : null}
                      tipo="subtotal"
                    />
                    <FilaCascada
                      etiqueta="Resultado del ejercicio"
                      valor={detalle.resultado ?? 0}
                      base={ing.total}
                      valorAnt={comp ? comp.resultado : null}
                      tipo="total"
                    />
                  </tbody>
                </table>
              </div>
            </Card>
            {gastos.porGrupo.length > 0 && (
              <p className="text-xs text-ink-faint">
                Los grupos de gasto se despliegan a subcuenta. Los porcentajes son sobre ingresos totales. La
                columna {vs} es el mismo mes del año anterior; un grupo o subcuenta sin movimiento ese mes cuenta
                como 0.
              </p>
            )}
          </section>
        </>
      )}

      {/* Tendencia */}
      {tendencia.length > 0 && (
        <section className="space-y-3">
          <SectionTitle>Tendencia · meses completos</SectionTitle>
          <Card>
            <GraficoTendencia meses={tendencia} />
          </Card>
        </section>
      )}
    </div>
  );
}
