'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { VentaPorClave } from '@/lib/hgi/mappers/ventas';
import { PageHeader, SectionTitle, KpiCard, Card, Th, EmptyState, FilterButton, Tone } from '@/components/ui';
import { formatPrice, kpiMoney } from '@/lib/format';

/**
 * Vista Gerencia con dos lecturas: AÑO y MES.
 *
 * No calcula nada de negocio. Todos los agregados llegan ya resueltos de
 * /api/gerencia, que los computa en el lambda sobre el snapshot — la vista nunca
 * baja las 18k líneas de ventas para agrupar en el browser. Las reglas de margen
 * viven en lib/hgi/mappers/ventas.ts.
 */

const MESES_CORTO = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
const MESES_LARGO = [
  'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
  'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre',
];

const pctFmt = (v: number) => `${(v * 100).toFixed(1)}%`;
const miles = (n: number) => n.toLocaleString('es-CO');

/** 'YYYY-MM' → "julio 2026". */
const mesLargo = (mes: string) => {
  const [y, m] = mes.split('-');
  return `${MESES_LARGO[Number(m) - 1] ?? mes} ${y}`;
};

/** Desplaza un 'YYYY-MM' en n meses. */
function desplazarMes(mes: string, n: number): string {
  const [y, m] = mes.split('-').map(Number);
  const total = y * 12 + (m - 1) + n;
  return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, '0')}`;
}

// ---- Tipos de la respuesta de /api/gerencia ----

interface Kpis {
  venta: number;
  costo: number;
  margen: number;
  margenPct: number;
  documentos: number;
  lineas: number;
  ticketPromedio: number;
  clientesActivos: number;
}

interface PuntoMes {
  mes: string;
  venta: number;
  costo: number;
  margen: number;
  documentos: number;
  parcial: boolean;
  sinDatos: boolean;
}

interface PuntoDia {
  fecha: string;
  venta: number;
  costo: number;
  margen: number;
  documentos: number;
}

interface DocFila {
  documento: string;
  fecha: string;
  tercero: string;
  nitTercero: string;
  vendedor: string;
  transaccion: string;
  esNotaCredito: boolean;
  numeroPedido: string;
  lineas: number;
  venta: number;
  margen: number;
  margenPct: number;
}

interface CarteraKpis {
  totalAbierto: number;
  totalVencido: number;
  pct90: number;
  terceros: number;
}

interface Respuesta {
  ok: boolean;
  vista: 'anio' | 'mes';
  mensaje?: string;
  avisos?: string[];
  kpis?: Kpis;
  cartera?: CarteraKpis | null;
  topClientes?: VentaPorClave[];
  topProductos?: VentaPorClave[];
  porLinea?: VentaPorClave[];
  porVendedor?: VentaPorClave[];
  // año
  anio?: string;
  serie?: PuntoMes[];
  anioAnterior?: { anio: string; kpis: Kpis; mesesConDatos: number } | null;
  variacion?: { venta: number | null; margen: number | null; margenPctPuntos: number | null } | null;
  mesesConDatos?: number;
  // mes
  mes?: string;
  detalle?: boolean;
  serieDia?: PuntoDia[];
  filtros?: { vendedores: string[]; lineas: string[]; grupos: string[] };
  documentos?: { page: number; pageSize: number; total: number; filas: DocFila[] };
  mesActual?: string;
  builtAt?: string;
  /** Horizonte de meses que el backfill mantiene, para el selector. */
  mesesDisponibles?: string[];
}

/** Variación con signo explícito, o texto neutro si no hay base comparable. */
function delta(v: number | null | undefined, sufijo: string, base: string): { texto: string; tone: Tone } {
  if (v === null || v === undefined || !Number.isFinite(v)) {
    return { texto: `sin ${base} comparable`, tone: 'neutral' };
  }
  return {
    texto: `${v > 0 ? '+' : ''}${(v * 100).toFixed(1)}${sufijo} vs ${base}`,
    tone: v >= 0 ? 'accent' : 'danger',
  };
}

// ---- Gráficos ----

/**
 * Barras apiladas costo + margen = venta, sobre 12 meses o sobre los días del
 * mes. Un mes sin construir se dibuja como hueco rayado, NO como cero: cero
 * significaría "no vendió nada", que es una afirmación distinta.
 */
function GraficoBarras({
  puntos,
  alto = 200,
}: {
  puntos: Array<{ clave: string; etiqueta: string; venta: number; costo: number; margen: number; documentos: number; sinDatos?: boolean; parcial?: boolean }>;
  alto?: number;
}) {
  if (!puntos.length) return <EmptyState title="Sin datos en el periodo" />;
  const max = Math.max(1, ...puntos.map((p) => Math.abs(p.venta)));

  return (
    <div className="overflow-x-auto">
      <div className="flex min-w-full items-end gap-1.5 px-4 pb-2 pt-6" style={{ height: alto + 50 }}>
        {puntos.map((p) => {
          const hVenta = (Math.abs(p.venta) / max) * alto;
          const hCosto = (Math.abs(p.costo) / max) * alto;
          return (
            <div key={p.clave} className="group flex flex-1 flex-col items-center justify-end" style={{ minWidth: 18 }}>
              {p.sinDatos ? (
                <div
                  className="w-full max-w-[34px] rounded-t border border-dashed border-line-strong bg-surface-muted"
                  style={{ height: 10 }}
                  title={`${p.etiqueta} · sin construir`}
                />
              ) : (
                <div
                  className="relative flex w-full max-w-[34px] flex-col justify-end rounded-t"
                  style={{ height: Math.max(2, hVenta) }}
                  title={`${p.etiqueta} · venta ${formatPrice(p.venta)} · costo ${formatPrice(p.costo)} · margen ${formatPrice(p.margen)} · ${miles(p.documentos)} doc.${p.parcial ? ' · mes en curso (parcial)' : ''}`}
                >
                  <div
                    className={`w-full rounded-t ${p.parcial ? 'bg-accent-light opacity-70' : 'bg-accent-light'}`}
                    style={{ height: Math.max(0, hVenta - hCosto) }}
                  />
                  <div className={`w-full ${p.parcial ? 'bg-accent opacity-70' : 'bg-accent'}`} style={{ height: hCosto }} />
                </div>
              )}
              <div className="mt-1.5 tabular text-[10px] text-ink-faint">{p.etiqueta}</div>
            </div>
          );
        })}
      </div>
      <div className="flex flex-wrap items-center gap-4 border-t border-line px-4 py-2 text-xs text-ink-muted">
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-2.5 rounded-sm bg-accent" /> Costo
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-2.5 rounded-sm bg-accent-light" /> Margen
        </span>
        {puntos.some((p) => p.sinDatos) && (
          <span className="flex items-center gap-1.5">
            <span className="inline-block h-2.5 w-2.5 rounded-sm border border-dashed border-line-strong bg-surface-muted" />
            Sin construir
          </span>
        )}
        <span className="text-ink-faint">La altura total es la venta</span>
      </div>
    </div>
  );
}

/** Ranking con barra de proporción sobre la venta. */
function Ranking({ filas, etiqueta, vacio }: { filas: VentaPorClave[]; etiqueta: string; vacio: string }) {
  if (!filas.length) return <EmptyState title={vacio} />;
  const max = Math.max(1, ...filas.map((f) => Math.abs(f.venta)));

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="bg-surface-muted">
          <tr>
            <Th>{etiqueta}</Th>
            <Th align="right">Venta</Th>
            <Th align="right">Margen</Th>
            <Th align="right">%</Th>
          </tr>
        </thead>
        <tbody>
          {filas.map((f) => (
            <tr key={f.clave} className="border-t border-line hover:bg-surface-hover">
              <td className="px-4 py-2.5">
                <div className="truncate text-ink" title={f.nombre}>
                  {f.nombre}
                </div>
                <div className="mt-1 h-1 w-full rounded bg-surface-muted">
                  <div
                    className="h-1 rounded bg-accent"
                    style={{ width: `${Math.max(2, (Math.abs(f.venta) / max) * 100)}%` }}
                  />
                </div>
              </td>
              <td className="tabular whitespace-nowrap px-4 py-2.5 text-right text-ink">{formatPrice(f.venta)}</td>
              <td className="tabular whitespace-nowrap px-4 py-2.5 text-right text-ink-muted">{formatPrice(f.margen)}</td>
              <td
                className={`tabular whitespace-nowrap px-4 py-2.5 text-right font-medium ${
                  f.margenPct < 0 ? 'text-danger' : 'text-accent'
                }`}
              >
                {pctFmt(f.margenPct)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Bloque de KPIs común a las dos vistas. */
function BloqueKpis({
  k,
  cartera,
  base,
  variacion,
  etiquetaVenta,
}: {
  k: Kpis | undefined;
  cartera: CarteraKpis | null | undefined;
  base: string;
  variacion: Respuesta['variacion'];
  etiquetaVenta: string;
}) {
  const dVenta = delta(variacion?.venta, '%', base);
  const pts = variacion?.margenPctPuntos;
  const pct90 = cartera?.pct90 ?? null;

  return (
    <>
      <section className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
        <KpiCard label={etiquetaVenta} {...kpiMoney(k?.venta ?? 0)} delta={dVenta.texto} tone={dVenta.tone} />
        <KpiCard
          label="Margen"
          value={k ? pctFmt(k.margenPct) : '—'}
          tone={(k?.margen ?? 0) >= 0 ? 'accent' : 'danger'}
          delta={
            pts === null || pts === undefined
              ? `sin ${base} comparable`
              : `${pts >= 0 ? '+' : ''}${(pts * 100).toFixed(1)} pp vs ${base}`
          }
          hint={k ? `${formatPrice(k.margen)} sobre ${formatPrice(k.costo)} de costo` : undefined}
        />
        <KpiCard label="Documentos" value={k ? miles(k.documentos) : '—'} hint={k ? `${miles(k.lineas)} líneas` : undefined} />
        <KpiCard label="Ticket promedio" {...kpiMoney(k?.ticketPromedio ?? 0)} hint="Venta ÷ documentos" />
        <KpiCard
          label="Clientes activos"
          value={k ? miles(k.clientesActivos) : '—'}
          hint="Con al menos un documento en el periodo"
        />
        <KpiCard
          label="Cartera abierta"
          {...kpiMoney(cartera?.totalAbierto ?? 0)}
          tone={pct90 !== null && pct90 > 0.2 ? 'danger' : pct90 !== null && pct90 > 0.1 ? 'warn' : 'neutral'}
          delta={pct90 !== null ? `${pctFmt(pct90)} con más de 90 días` : undefined}
          hint={cartera ? `${miles(cartera.terceros)} terceros · foto de hoy, no del periodo` : undefined}
        />
      </section>
    </>
  );
}

// ---- Vista ----

export default function GerenciaView() {
  const hoyMes = useMemo(() => new Date().toISOString().slice(0, 7), []);

  const [vista, setVista] = useState<'anio' | 'mes'>('anio');
  const [anio, setAnio] = useState(() => hoyMes.slice(0, 4));
  const [mes, setMes] = useState(hoyMes);

  const [vendedor, setVendedor] = useState('');
  const [linea, setLinea] = useState('');
  const [grupo, setGrupo] = useState('');
  const [clienteInput, setClienteInput] = useState('');
  const [cliente, setCliente] = useState('');
  const [page, setPage] = useState(1);

  const [d, setD] = useState<Respuesta | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // El texto de cliente se debouncea: cada tecla dispararía un recálculo del mes.
  useEffect(() => {
    const t = setTimeout(() => setCliente(clienteInput.trim()), 350);
    return () => clearTimeout(t);
  }, [clienteInput]);

  // Cambiar de mes o de filtro vuelve a la primera página.
  useEffect(() => setPage(1), [mes, vendedor, linea, grupo, cliente]);

  const url = useMemo(() => {
    const p = new URLSearchParams({ vista });
    if (vista === 'anio') {
      p.set('anio', anio);
    } else {
      p.set('mes', mes);
      p.set('page', String(page));
      if (vendedor) p.set('vendedor', vendedor);
      if (linea) p.set('linea', linea);
      if (grupo) p.set('grupo', grupo);
      if (cliente) p.set('cliente', cliente);
    }
    return `/api/gerencia?${p}`;
  }, [vista, anio, mes, page, vendedor, linea, grupo, cliente]);

  const cargar = useCallback(async () => {
    setLoading(true);
    // .catch(() => null) sobre el FETCH, no sólo sobre el .json(): un fetch que
    // rechaza (504 que corta la conexión, red caída) no debe tumbar la vista.
    const res = await fetch(url).catch(() => null);
    if (!res) {
      setError('No se pudo contactar al servidor');
      setLoading(false);
      return;
    }
    const json = (await res.json().catch(() => null)) as Respuesta | null;
    if (!json) {
      setError(`Respuesta ilegible (HTTP ${res.status})`);
    } else {
      setError(json.ok === false ? json.mensaje ?? 'Error desconocido' : null);
      setD(json);
    }
    setLoading(false);
  }, [url]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!cancelled) await cargar();
    })();
    return () => {
      cancelled = true;
    };
  }, [cargar]);

  const k = d?.kpis;
  const detalle = d?.vista === 'mes' && d?.detalle === true;
  const hayFiltro = !!(vendedor || linea || grupo || cliente);

  const puntosAnio = (d?.serie ?? []).map((s) => ({
    clave: s.mes,
    etiqueta: MESES_CORTO[Number(s.mes.split('-')[1]) - 1] ?? s.mes,
    venta: s.venta,
    costo: s.costo,
    margen: s.margen,
    documentos: s.documentos,
    sinDatos: s.sinDatos,
    parcial: s.parcial,
  }));

  const puntosMes = (d?.serieDia ?? []).map((s) => ({
    clave: s.fecha,
    etiqueta: s.fecha.slice(8),
    venta: s.venta,
    costo: s.costo,
    margen: s.margen,
    documentos: s.documentos,
  }));

  const subtitle = (
    <>
      {loading && <span className="block">Calculando indicadores…</span>}
      {error && <span className="block text-danger">No se pudo cargar: {error}</span>}
      {(d?.avisos ?? []).map((a) => (
        <span key={a} className="block text-warn">
          ⚠ {a}
        </span>
      ))}
      {!loading && !error && d && (
        <span className="tabular block text-xs text-ink-faint">
          {d.vista === 'anio'
            ? `Año ${d.anio} · ${d.mesesConDatos ?? 0} de 12 meses construidos`
            : `${mesLargo(d.mes ?? mes)}${detalle ? ' · mes en curso' : ' · mes cerrado'}`}
          {k ? ` · ${miles(k.documentos)} documentos · ${miles(k.lineas)} líneas` : ''}
        </span>
      )}
    </>
  );

  const totalPaginas = d?.documentos ? Math.max(1, Math.ceil(d.documentos.total / d.documentos.pageSize)) : 1;

  return (
    <div className="space-y-8">
      <PageHeader title="Gerencia" subtitle={subtitle} />

      {/* Toggle Año / Mes */}
      <div className="flex flex-wrap items-center gap-2">
        <FilterButton active={vista === 'anio'} onClick={() => setVista('anio')}>
          Año
        </FilterButton>
        <FilterButton active={vista === 'mes'} onClick={() => setVista('mes')}>
          Mes
        </FilterButton>

        <span className="mx-2 h-6 w-px bg-line" />

        {vista === 'anio' ? (
          <div className="flex items-center gap-1.5">
            <button
              onClick={() => setAnio(String(Number(anio) - 1))}
              className="rounded border border-line px-2.5 py-1.5 text-sm text-ink-muted transition-colors hover:bg-surface-hover hover:text-ink"
              aria-label="Año anterior"
            >
              ←
            </button>
            <span className="tabular min-w-[4rem] text-center font-serif text-base font-semibold text-ink">{anio}</span>
            <button
              onClick={() => setAnio(String(Number(anio) + 1))}
              className="rounded border border-line px-2.5 py-1.5 text-sm text-ink-muted transition-colors hover:bg-surface-hover hover:text-ink"
              aria-label="Año siguiente"
            >
              →
            </button>
          </div>
        ) : (
          <div className="flex items-center gap-1.5">
            <button
              onClick={() => setMes(desplazarMes(mes, -1))}
              className="rounded border border-line px-2.5 py-1.5 text-sm text-ink-muted transition-colors hover:bg-surface-hover hover:text-ink"
              aria-label="Mes anterior"
            >
              ←
            </button>
            <select
              value={mes}
              onChange={(e) => setMes(e.target.value)}
              className="rounded border border-line bg-surface px-3 py-1.5 text-sm text-ink"
            >
              {(d?.mesesDisponibles ?? [mes]).map((m) => (
                <option key={m} value={m}>
                  {mesLargo(m)}
                </option>
              ))}
            </select>
            <button
              onClick={() => setMes(desplazarMes(mes, 1))}
              className="rounded border border-line px-2.5 py-1.5 text-sm text-ink-muted transition-colors hover:bg-surface-hover hover:text-ink"
              aria-label="Mes siguiente"
            >
              →
            </button>
          </div>
        )}
      </div>

      {/* Filtros: sólo cuando hay detalle de línea (mes en curso) */}
      {vista === 'mes' && detalle && d?.filtros && (
        <Card>
          <div className="flex flex-wrap items-end gap-3 p-4">
            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium uppercase tracking-wider text-ink-muted">Vendedor</span>
              <select
                value={vendedor}
                onChange={(e) => setVendedor(e.target.value)}
                className="min-w-[12rem] rounded border border-line bg-surface px-3 py-2 text-sm text-ink"
              >
                <option value="">Todos</option>
                {d.filtros.vendedores.map((v) => (
                  <option key={v} value={v}>
                    {v}
                  </option>
                ))}
              </select>
            </label>

            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium uppercase tracking-wider text-ink-muted">Línea</span>
              <select
                value={linea}
                onChange={(e) => setLinea(e.target.value)}
                className="min-w-[12rem] rounded border border-line bg-surface px-3 py-2 text-sm text-ink"
              >
                <option value="">Todas</option>
                {d.filtros.lineas.map((v) => (
                  <option key={v} value={v}>
                    {v}
                  </option>
                ))}
              </select>
            </label>

            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium uppercase tracking-wider text-ink-muted">Grupo</span>
              <select
                value={grupo}
                onChange={(e) => setGrupo(e.target.value)}
                className="min-w-[12rem] rounded border border-line bg-surface px-3 py-2 text-sm text-ink"
              >
                <option value="">Todos</option>
                {d.filtros.grupos.map((v) => (
                  <option key={v} value={v}>
                    {v}
                  </option>
                ))}
              </select>
            </label>

            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium uppercase tracking-wider text-ink-muted">Cliente</span>
              <input
                type="text"
                value={clienteInput}
                onChange={(e) => setClienteInput(e.target.value)}
                placeholder="Nombre o NIT…"
                className="min-w-[14rem] rounded border border-line bg-surface px-3 py-2 text-sm text-ink placeholder:text-ink-faint"
              />
            </label>

            {hayFiltro && (
              <button
                onClick={() => {
                  setVendedor('');
                  setLinea('');
                  setGrupo('');
                  setClienteInput('');
                }}
                className="rounded border border-line px-3 py-2 text-sm text-ink-muted transition-colors hover:bg-surface-hover hover:text-ink"
              >
                Limpiar filtros
              </button>
            )}
          </div>
        </Card>
      )}

      <BloqueKpis
        k={k}
        cartera={d?.cartera}
        base={vista === 'anio' ? 'año anterior' : 'mes anterior'}
        variacion={d?.variacion}
        etiquetaVenta={vista === 'anio' ? 'Venta neta del año' : 'Venta neta del mes'}
      />

      {/* Gráfico principal */}
      <section className="space-y-3">
        <SectionTitle>{vista === 'anio' ? 'Venta y costo por mes' : 'Venta y costo por día'}</SectionTitle>
        <Card>
          {vista === 'anio' ? (
            <GraficoBarras puntos={puntosAnio} />
          ) : detalle ? (
            <GraficoBarras puntos={puntosMes} />
          ) : (
            <EmptyState
              title="Sin serie diaria"
              hint="El detalle día a día sólo se conserva del mes en curso"
            />
          )}
        </Card>
      </section>

      {/* Comparativo interanual */}
      {vista === 'anio' && d?.anioAnterior && (
        <section className="space-y-3">
          <SectionTitle>Comparativo con {d.anioAnterior.anio}</SectionTitle>
          <Card>
            <div className="grid grid-cols-1 gap-4 p-6 sm:grid-cols-3">
              <div>
                <div className="text-xs font-medium uppercase tracking-wider text-ink-muted">Venta {d.anioAnterior.anio}</div>
                <div className="tabular mt-2 font-serif text-2xl font-semibold text-ink" title={formatPrice(d.anioAnterior.kpis.venta)}>
                  {kpiMoney(d.anioAnterior.kpis.venta).value}
                </div>
                <div className="mt-1 text-xs text-ink-faint">{d.anioAnterior.mesesConDatos} meses construidos</div>
              </div>
              <div>
                <div className="text-xs font-medium uppercase tracking-wider text-ink-muted">Margen {d.anioAnterior.anio}</div>
                <div className="tabular mt-2 font-serif text-2xl font-semibold text-ink">
                  {pctFmt(d.anioAnterior.kpis.margenPct)}
                </div>
                <div className="mt-1 text-xs text-ink-faint" title={formatPrice(d.anioAnterior.kpis.margen)}>
                  {kpiMoney(d.anioAnterior.kpis.margen).value}
                </div>
              </div>
              <div>
                <div className="text-xs font-medium uppercase tracking-wider text-ink-muted">Documentos {d.anioAnterior.anio}</div>
                <div className="tabular mt-2 font-serif text-2xl font-semibold text-ink">
                  {miles(d.anioAnterior.kpis.documentos)}
                </div>
                <div className="mt-1 text-xs text-ink-faint">
                  ticket {formatPrice(d.anioAnterior.kpis.ticketPromedio)}
                </div>
              </div>
            </div>
            {d.anioAnterior.mesesConDatos < 12 && (
              <p className="border-t border-line px-6 py-3 text-xs text-warn">
                ⚠ {d.anioAnterior.anio} tiene {d.anioAnterior.mesesConDatos} de 12 meses construidos: la comparación no es
                de años completos.
              </p>
            )}
          </Card>
        </section>
      )}

      <div className="grid grid-cols-1 gap-8 xl:grid-cols-2">
        <section className="space-y-3">
          <SectionTitle>Margen por línea de producto</SectionTitle>
          <Card className="overflow-hidden">
            <Ranking filas={d?.porLinea ?? []} etiqueta="Línea" vacio="Sin líneas en el periodo" />
          </Card>
        </section>

        <section className="space-y-3">
          <SectionTitle>Vendedores</SectionTitle>
          <Card className="overflow-hidden">
            <Ranking filas={d?.porVendedor ?? []} etiqueta="Vendedor" vacio="Sin vendedores en el periodo" />
          </Card>
        </section>
      </div>

      <div className="grid grid-cols-1 gap-8 xl:grid-cols-2">
        <section className="space-y-3">
          <SectionTitle>Top 10 clientes por valor</SectionTitle>
          <Card className="overflow-hidden">
            <Ranking filas={d?.topClientes ?? []} etiqueta="Cliente" vacio="Sin clientes en el periodo" />
          </Card>
        </section>

        <section className="space-y-3">
          <SectionTitle>Top 10 productos por valor</SectionTitle>
          <Card className="overflow-hidden">
            <Ranking filas={d?.topProductos ?? []} etiqueta="Producto" vacio="Sin productos en el periodo" />
          </Card>
        </section>
      </div>

      {/* Tabla de documentos del mes, paginada */}
      {vista === 'mes' && (
        <section className="space-y-3">
          <SectionTitle>Documentos del mes</SectionTitle>
          <Card className="overflow-hidden">
            {!detalle ? (
              <EmptyState
                title="Sin detalle de documentos"
                hint="Sólo el mes en curso conserva el detalle línea a línea"
              />
            ) : !d?.documentos?.filas.length ? (
              <EmptyState
                title="Sin documentos"
                hint={hayFiltro ? 'Ningún documento cumple los filtros' : undefined}
              />
            ) : (
              <>
                <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-3">
                  <p className="text-xs text-ink-muted">
                    {miles(d.documentos.total)} documentos
                    {hayFiltro ? ' (filtrados)' : ''} · página {d.documentos.page} de {totalPaginas}
                  </p>
                  <div className="flex items-center gap-1.5">
                    <button
                      onClick={() => setPage((p) => Math.max(1, p - 1))}
                      disabled={d.documentos.page <= 1}
                      className="rounded border border-line px-2.5 py-1 text-sm text-ink-muted transition-colors hover:bg-surface-hover hover:text-ink disabled:opacity-40"
                    >
                      ←
                    </button>
                    <button
                      onClick={() => setPage((p) => Math.min(totalPaginas, p + 1))}
                      disabled={d.documentos.page >= totalPaginas}
                      className="rounded border border-line px-2.5 py-1 text-sm text-ink-muted transition-colors hover:bg-surface-hover hover:text-ink disabled:opacity-40"
                    >
                      →
                    </button>
                  </div>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[860px] text-sm">
                    <thead className="bg-surface-muted">
                      <tr>
                        <Th>Documento</Th>
                        <Th>Fecha</Th>
                        <Th>Cliente</Th>
                        <Th>Vendedor</Th>
                        <Th align="center">Líneas</Th>
                        <Th align="right">Venta</Th>
                        <Th align="right">Margen</Th>
                        <Th align="right">%</Th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-line">
                      {d.documentos.filas.map((f) => (
                        <tr key={f.documento} className="hover:bg-surface-hover">
                          <td className="px-4 py-2.5">
                            <div className="tabular font-mono text-xs text-ink">{f.documento}</div>
                            <div className="mt-0.5 text-[11px] text-ink-faint">
                              {f.esNotaCredito ? 'Nota crédito' : 'Factura'}
                              {f.numeroPedido ? ` · pedido ${f.numeroPedido}` : ''}
                            </div>
                          </td>
                          <td className="tabular whitespace-nowrap px-4 py-2.5 text-xs text-ink-muted">{f.fecha}</td>
                          <td className="px-4 py-2.5">
                            <div className="max-w-[18rem] truncate text-ink" title={f.tercero}>
                              {f.tercero}
                            </div>
                            <div className="tabular mt-0.5 text-[11px] text-ink-faint">{f.nitTercero}</div>
                          </td>
                          <td className="px-4 py-2.5 text-xs text-ink-muted">{f.vendedor}</td>
                          <td className="tabular px-4 py-2.5 text-center text-ink-muted">{f.lineas}</td>
                          <td className="tabular whitespace-nowrap px-4 py-2.5 text-right text-ink">
                            {formatPrice(f.venta)}
                          </td>
                          <td className="tabular whitespace-nowrap px-4 py-2.5 text-right text-ink-muted">
                            {formatPrice(f.margen)}
                          </td>
                          <td
                            className={`tabular whitespace-nowrap px-4 py-2.5 text-right font-medium ${
                              f.margenPct < 0 ? 'text-danger' : 'text-accent'
                            }`}
                          >
                            {pctFmt(f.margenPct)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </Card>
        </section>
      )}
    </div>
  );
}
