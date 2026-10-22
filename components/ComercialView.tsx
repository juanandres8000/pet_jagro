'use client';

import { useEffect, useMemo, useState } from 'react';
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
            <Th align="right">Clientes</Th>
            <Th align="right">Hacen el 80 %</Th>
            <Th className="w-1/3" />
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
                <td className="tabular whitespace-nowrap px-4 py-2 text-right text-ink-muted">{miles(z.clientes)}</td>
                <td className="tabular whitespace-nowrap px-4 py-2 text-right text-ink-muted">{miles(z.clientes80)}</td>
                <td className="px-4 py-2">
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
              <td className="tabular whitespace-nowrap px-4 py-2 text-right">{miles(todas.clientes)}</td>
              <td className="tabular whitespace-nowrap px-4 py-2 text-right">{miles(todas.clientes80)}</td>
              <td />
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
        <p className="text-xs text-ink-faint">Clic en un cliente para ver sus compras por mes y por línea.</p>
      </div>
      <div className={`max-h-[560px] overflow-auto transition-opacity ${cargando ? 'opacity-50' : ''}`}>
        <table className="w-full text-sm">
          <thead className="sticky top-0 z-10 bg-surface-muted">
            <tr>
              <Th>#</Th>
              <Th>Cliente</Th>
              <Th align="right">Venta neta</Th>
              <Th align="right">% zona</Th>
              <Th align="right">% acum.</Th>
              {meses.map((m) => (
                <Th key={m} align="right">
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
                      className={`max-w-[18rem] truncate ${activo ? 'font-medium text-accent' : en80 ? 'text-ink' : 'text-ink-muted'}`}
                      title={`${c.nombre} · ${c.nit}`}
                    >
                      {c.nombre}
                    </div>
                  </td>
                  <td className="tabular whitespace-nowrap px-4 py-2 text-right text-ink">{formatPrice(c.venta)}</td>
                  <td className="tabular whitespace-nowrap px-4 py-2 text-right text-ink-muted">{pctFmt(c.pct)}</td>
                  <td className={`tabular whitespace-nowrap px-4 py-2 text-right ${en80 ? 'font-medium text-accent' : 'text-ink-muted'}`}>
                    {pctFmt(c.pctAcum)}
                  </td>
                  {c.porMes.map((v, j) => (
                    <td key={j} className="tabular whitespace-nowrap px-4 py-2 text-right text-ink-muted">
                      {v === 0 ? <span className="text-ink-faint">—</span> : formatPrice(v)}
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
        en ambas zonas y una sola vez en Todas las zonas.
      </div>
    </div>
  );
}

// ---- Consulta por cliente ----

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
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-surface-muted">
                <tr>
                  <Th>Línea</Th>
                  <Th align="right">Venta neta</Th>
                  <Th align="right">%</Th>
                  <Th align="right">Unidades</Th>
                  {meses.map((m) => (
                    <Th key={m} align="right">
                      {mesAbr(m)}
                    </Th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {lineas.map((l) => (
                  <tr key={l.linea} className="border-t border-line hover:bg-surface-hover">
                    <td className="whitespace-nowrap px-4 py-2 text-ink">{l.linea}</td>
                    <td className="tabular whitespace-nowrap px-4 py-2 text-right text-ink">{formatPrice(l.venta)}</td>
                    <td className="tabular whitespace-nowrap px-4 py-2 text-right text-ink-muted">
                      {pctFmt(d.totalLineas === 0 ? 0 : l.venta / d.totalLineas)}
                    </td>
                    <td className="tabular whitespace-nowrap px-4 py-2 text-right text-ink-muted">{miles(l.unidades)}</td>
                    {l.porMes.map((v, j) => (
                      <td key={j} className="tabular whitespace-nowrap px-4 py-2 text-right text-ink-muted">
                        {v === 0 ? <span className="text-ink-faint">—</span> : formatPrice(v)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t-2 border-line font-semibold text-ink">
                  <td className="px-4 py-2">Total</td>
                  <td className="tabular whitespace-nowrap px-4 py-2 text-right">{formatPrice(d.totalLineas)}</td>
                  <td className="tabular whitespace-nowrap px-4 py-2 text-right">100,0%</td>
                  <td className="tabular whitespace-nowrap px-4 py-2 text-right">
                    {miles(lineas.reduce((s, l) => s + l.unidades, 0))}
                  </td>
                  {meses.map((m, j) => (
                    <td key={m} className="tabular whitespace-nowrap px-4 py-2 text-right">
                      {formatPrice(lineas.reduce((s, l) => s + l.porMes[j], 0))}
                    </td>
                  ))}
                </tr>
              </tfoot>
            </table>
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
                <EmptyState title="Elegí un cliente en la tabla de arriba" hint="Se muestran sus compras por mes y por línea." />
              </Card>
            )}
          </section>
        </>
      )}
    </div>
  );
}
