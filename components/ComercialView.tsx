'use client';

import { Fragment, useEffect, useMemo, useState } from 'react';
import { PageHeader, SectionTitle, KpiCard, Card, Th, EmptyState, FilterButton } from '@/components/ui';
import { formatPrice, formatMillones, kpiMoney } from '@/lib/format';

/**
 * Apartado Comercial (vendedores): venta acumulada del año en curso por zona,
 * pareto de clientes de la zona y consulta por cliente (compras por mes y
 * línea de producto × año).
 *
 * No calcula nada de negocio: todo llega resuelto de /api/comercial, que reusa
 * el mismo pareto por zona que Gerencia (lib/hgi/comercial.ts).
 */

const MESES_CORTO = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

const pctFmt = (v: number) => `${(v * 100).toFixed(1)}%`;
const miles = (n: number) => n.toLocaleString('es-CO', { maximumFractionDigits: 0 });
const mesAbr = (mes: string) => MESES_CORTO[Number(mes.slice(5, 7)) - 1] ?? mes;
const mesCorto = (mes: string) => `${mesAbr(mes)} ${mes.slice(0, 4)}`;
/** Millones con un decimal y sin "$": "33,7". Para las columnas por mes, que no caben con el valor completo. */
const millones = (v: number) => (v / 1_000_000).toLocaleString('es-CO', { minimumFractionDigits: 1, maximumFractionDigits: 1 });

/**
 * Responsive. El contenido tope es max-w-6xl y desde lg el sidebar come 256 px:
 * diez columnas de meses no caben hasta 2xl, ni siquiera en millones. Debajo de
 * 2xl los meses del pareto se ven en la ficha del cliente y los de línea × año
 * se despliegan tocando la fila. Clases literales: Tailwind purga las interpoladas.
 */
const SOLO_LG = 'hidden lg:table-cell';
const SOLO_SM = 'hidden sm:table-cell';
const SOLO_2XL = 'hidden 2xl:table-cell';
/** 'YYYY-MM-DD' → "22 oct 2026". */
const fechaCorta = (iso: string) => `${Number(iso.slice(8, 10))} ${mesAbr(iso)} ${iso.slice(0, 4)}`;

// ---- Tipos de la respuesta de /api/comercial ----

interface Resumen {
  ok: boolean;
  mensaje?: string;
  anio: string;
  corte: string | null;
  meses: string[];
  zonas: Array<{ zona: string; venta: number; clientes80: number; clientes: number }>;
  mostradorExcluido: number;
  mesesSinDato: string[];
  avisos?: string[];
}

interface ClienteZona {
  nit: string;
  nombre: string;
  venta: number;
  pct: number;
  pctAcum: number;
  porMes: number[];
}

interface ZonaDetalle {
  meses: string[];
  zona: { zona: string; venta: number; clientes80: number; clientes: ClienteZona[] } | null;
}

interface ClienteResp {
  ok: boolean;
  mensaje?: string;
  anio: string;
  corte: string | null;
  meses: string[];
  cliente: { nit: string; nombre: string; venta: number; porMes: number[]; zonas: Array<{ zona: string; venta: number }> };
  lineas: Array<{ linea: string; venta: number; unidades: number; porMes: number[] }>;
  totalLineas: number;
  lineaSinDato: string[];
  avisos: string[];
}

/** fetch → JSON que nunca rechaza: un 504 o la red caída no tumban la vista. */
async function pedir<T>(url: string): Promise<T | null> {
  const res = await fetch(url).catch(() => null);
  if (!res) return null;
  return (await res.json().catch(() => null)) as T | null;
}

// ---- Venta acumulada por zona ----

function ZonasResumen({ data, zonaSel, onZona }: { data: Resumen; zonaSel: string; onZona: (z: string) => void }) {
  const [todas, ...zonas] = data.zonas;
  const max = Math.max(...zonas.map((z) => z.venta), 1);
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="bg-surface-muted">
          <tr>
            <Th>Zona</Th>
            <Th align="right">Venta neta</Th>
            <Th align="right">% del total</Th>
            <Th align="right" className={SOLO_SM}>
              Clientes
            </Th>
            <Th align="right" className={SOLO_SM}>
              Hacen el 80 %
            </Th>
            <Th className={`w-1/3 ${SOLO_SM}`} />
          </tr>
        </thead>
        <tbody>
          {zonas.map((z) => {
            const activa = z.zona === zonaSel;
            return (
              <tr
                key={z.zona}
                onClick={() => onZona(z.zona)}
                className={`cursor-pointer border-t border-line hover:bg-surface-hover ${activa ? 'bg-surface-hover' : ''}`}
              >
                <td className={`whitespace-nowrap px-4 py-2 ${activa ? 'border-l-2 border-l-accent font-medium text-accent' : 'text-ink'}`}>
                  {z.zona}
                </td>
                <td className="tabular whitespace-nowrap px-4 py-2 text-right text-ink">{formatPrice(z.venta)}</td>
                <td className="tabular whitespace-nowrap px-4 py-2 text-right text-ink-muted">
                  {todas ? pctFmt(todas.venta === 0 ? 0 : z.venta / todas.venta) : '—'}
                </td>
                <td className={`tabular whitespace-nowrap px-4 py-2 text-right text-ink-muted ${SOLO_SM}`}>{miles(z.clientes)}</td>
                <td className={`tabular whitespace-nowrap px-4 py-2 text-right text-ink-muted ${SOLO_SM}`}>{miles(z.clientes80)}</td>
                <td className={`px-4 py-2 ${SOLO_SM}`}>
                  <div className="h-2 rounded bg-surface-muted">
                    <div className="h-2 rounded bg-accent" style={{ width: `${Math.max(0, (z.venta / max) * 100)}%` }} />
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
        {todas && (
          <tfoot>
            <tr
              onClick={() => onZona(todas.zona)}
              className={`cursor-pointer border-t-2 border-line font-semibold hover:bg-surface-hover ${
                todas.zona === zonaSel ? 'bg-surface-hover text-accent' : 'text-ink'
              }`}
            >
              <td className="px-4 py-2">{todas.zona}</td>
              <td className="tabular whitespace-nowrap px-4 py-2 text-right">{formatPrice(todas.venta)}</td>
              <td className="tabular whitespace-nowrap px-4 py-2 text-right">100,0%</td>
              <td className={`tabular whitespace-nowrap px-4 py-2 text-right ${SOLO_SM}`}>{miles(todas.clientes)}</td>
              <td className={`tabular whitespace-nowrap px-4 py-2 text-right ${SOLO_SM}`}>{miles(todas.clientes80)}</td>
              <td className={SOLO_SM} />
            </tr>
          </tfoot>
        )}
      </table>
    </div>
  );
}

// ---- Pareto de clientes de la zona ----

function ParetoZona({
  detalle,
  cargando,
  nitSel,
  onCliente,
}: {
  detalle: ZonaDetalle | null;
  cargando: boolean;
  nitSel: string;
  onCliente: (nit: string) => void;
}) {
  const [buscar, setBuscar] = useState('');
  const zona = detalle?.zona ?? null;
  const meses = detalle?.meses ?? [];
  const q = buscar.trim().toLowerCase();
  // El filtro sólo oculta filas: el # y el % acumulado siguen siendo los del pareto completo.
  const filas = useMemo(
    () =>
      (zona?.clientes ?? [])
        .map((c, i) => ({ c, i }))
        .filter(({ c }) => !q || c.nombre.toLowerCase().includes(q) || c.nit.toLowerCase().includes(q)),
    [zona, q],
  );

  if (!zona) {
    return (
      <div className="px-4 py-8 text-center text-sm text-ink-muted">
        {cargando ? 'Cargando clientes de la zona…' : 'No se pudo cargar el detalle de la zona'}
      </div>
    );
  }

  return (
    <div>
      <div className="flex flex-wrap items-end gap-x-8 gap-y-3 border-b border-line px-4 py-4">
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium uppercase tracking-wider text-ink-muted">Buscar cliente</span>
          <input
            value={buscar}
            onChange={(e) => setBuscar(e.target.value)}
            placeholder="Nombre o NIT"
            className="min-w-[16rem] rounded border border-line bg-surface px-3 py-2 text-sm text-ink placeholder:text-ink-faint"
          />
        </label>
        <p className="text-xs text-ink-faint">Haga clic en un cliente para ver sus compras por mes y por línea.</p>
      </div>
      <div className={`max-h-[560px] overflow-auto transition-opacity ${cargando ? 'opacity-50' : ''}`}>
        <table className="w-full text-sm">
          <thead className="sticky top-0 z-10 bg-surface-muted">
            <tr>
              <Th>#</Th>
              <Th>Cliente</Th>
              <Th align="right">Venta neta</Th>
              <Th align="right" className={SOLO_LG}>
                % zona
              </Th>
              <Th align="right" className={SOLO_LG}>
                % acum.
              </Th>
              {meses.map((m) => (
                <Th key={m} align="right" className={SOLO_2XL}>
                  {mesAbr(m)}
                </Th>
              ))}
            </tr>
          </thead>
          <tbody>
            {filas.map(({ c, i }) => {
              const en80 = i < zona.clientes80;
              const activo = c.nit === nitSel;
              return (
                <tr
                  key={c.nit || `sin-nit-${i}`}
                  onClick={() => c.nit && onCliente(c.nit)}
                  className={`cursor-pointer border-t hover:bg-surface-hover ${activo ? 'bg-surface-hover' : ''} ${
                    !q && i === zona.clientes80 ? 'border-t-2 border-t-accent' : 'border-line'
                  }`}
                >
                  <td className={`tabular whitespace-nowrap px-4 py-2 text-ink-faint ${en80 ? 'border-l-2 border-l-accent' : ''}`}>
                    {i + 1}
                  </td>
                  <td className="px-4 py-2">
                    <div
                      className={`max-w-[7rem] truncate sm:max-w-[18rem] lg:max-w-[12rem] 2xl:max-w-[10rem] ${activo ? 'font-medium text-accent' : en80 ? 'text-ink' : 'text-ink-muted'}`}
                      title={`${c.nombre} · ${c.nit}`}
                    >
                      {c.nombre}
                    </div>
                  </td>
                  <td className="tabular whitespace-nowrap px-4 py-2 text-right text-ink">{formatPrice(c.venta)}</td>
                  <td className={`tabular whitespace-nowrap px-4 py-2 text-right text-ink-muted ${SOLO_LG}`}>{pctFmt(c.pct)}</td>
                  <td
                    className={`tabular whitespace-nowrap px-4 py-2 text-right ${SOLO_LG} ${
                      en80 ? 'font-medium text-accent' : 'text-ink-muted'
                    }`}
                  >
                    {pctFmt(c.pctAcum)}
                  </td>
                  {c.porMes.map((v, j) => (
                    <td
                      key={j}
                      title={formatPrice(v)}
                      className={`tabular whitespace-nowrap px-2 py-2 text-right text-ink-muted ${SOLO_2XL}`}
                    >
                      {v === 0 ? <span className="text-ink-faint">—</span> : millones(v)}
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
        {filas.length === 0 && <EmptyState title="Ningún cliente coincide con la búsqueda" />}
      </div>
      <div className="border-t border-line px-4 py-3 text-xs text-ink-faint">
        <span className="mr-1 inline-block h-2.5 w-0.5 bg-accent align-middle" /> Clientes que hacen el 80 % de la venta de la
        zona; la línea marca el corte. La zona es la del vendedor que facturó: un cliente atendido por dos vendedores aparece
        en ambas zonas y una sola vez en Todas las zonas.<span className="hidden 2xl:inline"> Meses en millones.</span>
      </div>
    </div>
  );
}

// ---- Consulta por cliente ----

/**
 * Cabecera de la tabla de líneas. No usa <Th>: su px-4 fijo no deja el padding
 * compacto que hace falta para caber en 390 px.
 */
const TH_LINEA = 'px-2 py-3 text-xs font-semibold uppercase tracking-wider text-ink-muted sm:px-4';
const TD_LINEA = 'tabular whitespace-nowrap px-2 py-2 text-right sm:px-4';

/**
 * Línea de producto × año. Desde 2xl, una columna por mes (en millones). Debajo,
 * línea, venta, % y unidades; los meses se despliegan tocando la fila.
 */
function TablaLineas({ lineas, meses, total }: { lineas: ClienteResp['lineas']; meses: string[]; total: number }) {
  const [abiertas, setAbiertas] = useState<Set<string>>(new Set());
  const alternar = (linea: string) =>
    setAbiertas((prev) => {
      const sig = new Set(prev);
      if (sig.has(linea)) sig.delete(linea);
      else sig.add(linea);
      return sig;
    });
  const columnas = 4;

  return (
    <table className="w-full text-xs sm:text-sm">
      <thead className="bg-surface-muted">
        <tr>
          <th className={`${TH_LINEA} text-left`}>Línea</th>
          <th className={`${TH_LINEA} text-right`}>Venta neta</th>
          <th className={`${TH_LINEA} text-right`}>%</th>
          <th className={`${TH_LINEA} text-right`}>
            <span className="sm:hidden">Unid.</span>
            <span className="hidden sm:inline">Unidades</span>
          </th>
          {meses.map((m) => (
            <th key={m} className={`${TH_LINEA} text-right ${SOLO_2XL}`}>
              {mesAbr(m)}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {lineas.map((l) => {
          const abierta = abiertas.has(l.linea);
          return (
            <Fragment key={l.linea}>
              <tr
                onClick={() => alternar(l.linea)}
                aria-expanded={abierta}
                className="cursor-pointer border-t border-line hover:bg-surface-hover 2xl:cursor-default"
              >
                <td className="px-2 py-2 text-ink sm:px-4">
                  <span className="mr-1 inline-block w-3 text-ink-faint 2xl:hidden">{abierta ? '▾' : '▸'}</span>
                  {l.linea}
                </td>
                <td className={`${TD_LINEA} text-ink`}>{formatPrice(l.venta)}</td>
                <td className={`${TD_LINEA} text-ink-muted`}>{pctFmt(total === 0 ? 0 : l.venta / total)}</td>
                <td className={`${TD_LINEA} text-ink-muted`}>{miles(l.unidades)}</td>
                {l.porMes.map((v, j) => (
                  <td key={j} title={formatPrice(v)} className={`${TD_LINEA} text-ink-muted ${SOLO_2XL}`}>
                    {v === 0 ? <span className="text-ink-faint">—</span> : millones(v)}
                  </td>
                ))}
              </tr>
              {abierta && (
                <tr className="bg-cream 2xl:hidden">
                  <td colSpan={columnas} className="px-2 py-3 sm:px-4">
                    <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs sm:grid-cols-5">
                      {meses.map((m, j) => (
                        <div key={m} className="flex justify-between gap-2">
                          <dt className="text-ink-muted">{mesAbr(m)}</dt>
                          <dd className="tabular text-ink">
                            {l.porMes[j] === 0 ? <span className="text-ink-faint">—</span> : formatPrice(l.porMes[j])}
                          </dd>
                        </div>
                      ))}
                    </dl>
                  </td>
                </tr>
              )}
            </Fragment>
          );
        })}
      </tbody>
      <tfoot>
        <tr className="border-t-2 border-line font-semibold text-ink">
          <td className="px-2 py-2 sm:px-4">Total</td>
          <td className={TD_LINEA}>{formatPrice(total)}</td>
          <td className={TD_LINEA}>100,0%</td>
          <td className={TD_LINEA}>{miles(lineas.reduce((s, l) => s + l.unidades, 0))}</td>
          {meses.map((m, j) => (
            <td key={m} className={`${TD_LINEA} ${SOLO_2XL}`}>
              {millones(lineas.reduce((s, l) => s + l.porMes[j], 0))}
            </td>
          ))}
        </tr>
      </tfoot>
    </table>
  );
}

function FichaCliente({ d, cargando }: { d: ClienteResp | null; cargando: boolean }) {
  if (!d) {
    return <EmptyState title={cargando ? 'Cargando cliente…' : 'No se pudo cargar el cliente'} />;
  }
  const { cliente, lineas, meses } = d;
  const maxMes = Math.max(...cliente.porMes, 1);

  return (
    <div className={`space-y-6 transition-opacity ${cargando ? 'opacity-50' : ''}`}>
      <div className="grid gap-4 sm:grid-cols-3">
        <KpiCard label={`Compras ${d.anio}`} {...kpiMoney(cliente.venta)} tone="accent" />
        <KpiCard label="Meses con compra" value={`${cliente.porMes.filter((v) => v !== 0).length} de ${meses.length}`} />
        <KpiCard
          label="Zona"
          value={<span className="text-xl">{cliente.zonas.map((z) => z.zona).join(' · ') || '—'}</span>}
          hint={cliente.zonas.length > 1 ? 'Atendido por más de un vendedor' : undefined}
        />
      </div>

      <Card>
        <div className="border-b border-line px-4 py-3">
          <SectionTitle as="h3">Compras por mes</SectionTitle>
        </div>
        <div className="flex items-end gap-2 px-4 pb-2 pt-6" style={{ height: 180 }}>
          {cliente.porMes.map((v, i) => (
            <div key={meses[i]} className="flex h-full flex-1 flex-col items-center justify-end gap-1">
              <div className="tabular text-[10px] text-ink-faint">{v === 0 ? '' : formatMillones(v).replace('$ ', '')}</div>
              <div
                className={`w-full max-w-[2.5rem] rounded-t ${v < 0 ? 'bg-danger' : 'bg-accent'}`}
                style={{ height: `${(Math.abs(v) / maxMes) * 100}%`, minHeight: v === 0 ? 0 : 2 }}
                title={`${mesCorto(meses[i])}: ${formatPrice(v)}`}
              />
            </div>
          ))}
        </div>
        <div className="flex gap-2 border-b border-line px-4 pb-3">
          {meses.map((m) => (
            <div key={m} className="flex-1 text-center text-xs text-ink-muted">
              {mesAbr(m)}
            </div>
          ))}
        </div>
        <div className="px-4 py-2 text-xs text-ink-faint">Venta neta en millones; las notas crédito restan.</div>
      </Card>

      <Card>
        <div className="border-b border-line px-4 py-3">
          <SectionTitle as="h3">Línea de producto × año</SectionTitle>
        </div>
        {lineas.length === 0 ? (
          <EmptyState title="Sin compras por línea en el año" />
        ) : (
          <TablaLineas lineas={lineas} meses={meses} total={d.totalLineas} />
        )}
        {lineas.length > 0 && (
          <div className="border-t border-line px-4 py-3 text-xs text-ink-faint">
            <span className="2xl:hidden">Toque una línea para ver sus compras por mes.</span>
            <span className="hidden 2xl:inline">Meses en millones; el valor completo aparece al pasar el cursor.</span>
          </div>
        )}
        {d.lineaSinDato.length > 0 && (
          <div className="border-t border-line px-4 py-3 text-xs text-warn">
            ⚠ Línea de producto sin construir para {d.lineaSinDato.map(mesCorto).join(', ')}: el total por línea no incluye
            esos meses.
          </div>
        )}
      </Card>
    </div>
  );
}

// ---- Vista ----

export default function ComercialView() {
  const [resumen, setResumen] = useState<Resumen | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [zonaSel, setZonaSel] = useState('');
  const [detalle, setDetalle] = useState<ZonaDetalle | null>(null);
  const [cargandoZona, setCargandoZona] = useState(false);

  const [nit, setNit] = useState('');
  const [cliente, setCliente] = useState<ClienteResp | null>(null);
  const [cargandoCliente, setCargandoCliente] = useState(false);

  useEffect(() => {
    let vigente = true;
    pedir<Resumen>('/api/comercial?parte=zonas').then((j) => {
      if (!vigente) return;
      if (!j) setError('No se pudo contactar al servidor');
      else if (j.ok === false) setError(j.mensaje ?? 'Error desconocido');
      else setResumen(j);
      setLoading(false);
    });
    return () => {
      vigente = false;
    };
  }, []);

  // "Todas las zonas" llega primero y es la selección por defecto.
  const zona = zonaSel || resumen?.zonas[0]?.zona || '';
  const resumenZona = resumen?.zonas.find((z) => z.zona === zona);

  useEffect(() => {
    if (!zona) return;
    let vigente = true;
    setCargandoZona(true);
    pedir<{ zonaDetalle?: ZonaDetalle }>(`/api/comercial?parte=zona&zona=${encodeURIComponent(zona)}`).then((j) => {
      if (!vigente) return;
      setDetalle(j?.zonaDetalle ?? null);
      setCargandoZona(false);
    });
    return () => {
      vigente = false;
    };
  }, [zona]);

  useEffect(() => {
    if (!nit) return;
    let vigente = true;
    setCargandoCliente(true);
    pedir<ClienteResp>(`/api/comercial?parte=cliente&nit=${encodeURIComponent(nit)}`).then((j) => {
      if (!vigente) return;
      setCliente(j && j.ok !== false ? j : null);
      setCargandoCliente(false);
    });
    return () => {
      vigente = false;
    };
  }, [nit]);

  const subtitle = (
    <>
      {loading && <span className="block">Calculando venta por zona…</span>}
      {error && <span className="block text-danger">No se pudo cargar: {error}</span>}
      {(resumen?.avisos ?? []).map((a) => (
        <span key={a} className="block text-warn">
          ⚠ {a}
        </span>
      ))}
      {resumen && (
        <span className="tabular block text-xs text-ink-faint">
          Año {resumen.anio} acumulado{resumen.corte ? ` · corte al ${fechaCorta(resumen.corte)}` : ''} · venta neta antes de
          IVA
        </span>
      )}
    </>
  );

  return (
    <div className="space-y-8">
      <PageHeader title="Comercial" subtitle={subtitle} />

      {resumen && (
        <>
          <div className="flex flex-wrap items-center gap-2">
            {resumen.zonas.map((z) => (
              <FilterButton key={z.zona} active={z.zona === zona} onClick={() => setZonaSel(z.zona)}>
                {z.zona}
              </FilterButton>
            ))}
          </div>

          {resumenZona && (
            <div className="grid gap-4 sm:grid-cols-3">
              <KpiCard label={`Venta ${resumen.anio} · ${resumenZona.zona}`} {...kpiMoney(resumenZona.venta)} tone="accent" />
              <KpiCard label="Clientes con compra" value={miles(resumenZona.clientes)} />
              <KpiCard
                label="Hacen el 80 %"
                value={`${miles(resumenZona.clientes80)} ${resumenZona.clientes80 === 1 ? 'cliente' : 'clientes'}`}
              />
            </div>
          )}

          <section className="space-y-3">
            <SectionTitle>Venta acumulada por zona</SectionTitle>
            <Card>
              <ZonasResumen data={resumen} zonaSel={zona} onZona={setZonaSel} />
              {resumen.mostradorExcluido !== 0 && (
                <div className="border-t border-line px-4 py-3 text-xs text-ink-faint">
                  Excluye VENTAS MOSTRADOR (NIT 22222222): {formatPrice(resumen.mostradorExcluido)} en el año.
                </div>
              )}
            </Card>
          </section>

          <section className="space-y-3">
            <SectionTitle>Clientes de {zona}</SectionTitle>
            <Card>
              <ParetoZona detalle={detalle} cargando={cargandoZona} nitSel={nit} onCliente={setNit} />
            </Card>
          </section>

          <section className="space-y-3">
            <SectionTitle>{cliente && nit ? `${cliente.cliente.nombre} · ${cliente.cliente.nit}` : 'Consulta por cliente'}</SectionTitle>
            {nit ? (
              <FichaCliente d={cliente} cargando={cargandoCliente} />
            ) : (
              <Card>
                <EmptyState title="Seleccione un cliente en la tabla de arriba" hint="Se muestran sus compras por mes y por línea." />
              </Card>
            )}
          </section>
        </>
      )}
    </div>
  );
}
