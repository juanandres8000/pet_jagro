'use client';

import { Fragment, useEffect, useMemo, useState } from 'react';
import { PageHeader, SectionTitle, KpiCard, Card, Th, EmptyState, FilterButton, Badge, type Tone } from '@/components/ui';
import { formatPrice, kpiMoney } from '@/lib/format';

/**
 * Descuentos diferenciados (docs/DESCUENTOS.md): separa el precio cero —lo que
 * Jotagro regala en factura y hoy se come el margen— de lo que el laboratorio le
 * devuelve, y genera el reporte "PRECIO CERO <LAB>" que antes se armaba a mano.
 *
 * No calcula nada de negocio: todo llega resuelto de /api/descuentos.
 */

interface Lab {
  nit: string;
  nombre: string;
  ventaNeta: number;
  margen: number;
  margenPct: number | null;
  margenSinPrecioCeroPct: number | null;
  descuentoLinea: number;
  precioCero: { costo: number; lista: number; unidades: number; pctVenta: number | null };
  recibidoMercancia: number;
  unidadesRecibidas: number;
  descuentoFacturaCompra: number;
  descuentoAlPagar: number;
  compensacionObservada: number;
  cobertura: number | null;
  brecha: number;
  estado: 'sin_precio_cero' | 'cubierto' | 'parcial' | 'sin_compensacion';
}

interface Totales {
  ventaNeta: number;
  margen: number;
  margenPct: number | null;
  margenSinPrecioCeroPct: number | null;
  descuentoLinea: number;
  precioCeroCosto: number;
  precioCeroLista: number;
  precioCeroPctVenta: number | null;
  recibidoMercancia: number;
  descuentoFacturaCompra: number;
  descuentoAlPagar: number;
  brecha: number;
  labsConPrecioCero: number;
  labsConBrecha: number;
}

interface Resp {
  ok: boolean;
  mensaje?: string;
  completo: boolean;
  desde: string;
  hasta: string;
  meses: string[];
  mesesSinDatos: string[];
  mesesDisponibles: string[];
  incluyeMesAbierto?: boolean;
  totales: Totales | null;
  alPagar: { meses: string[]; mesesSinDato: string[] };
  labs: Lab[];
}

const MESES_CORTO = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
const mesCorto = (mes: string) => `${MESES_CORTO[Number(mes.slice(5, 7)) - 1] ?? mes} ${mes.slice(0, 4)}`;
const pctFmt = (v: number | null) => (v === null ? '—' : `${(v * 100).toFixed(1)}%`);
const miles = (n: number) => n.toLocaleString('es-CO', { maximumFractionDigits: 0 });
const finDeMes = (mes: string) => {
  const [y, m] = mes.split('-').map(Number);
  return `${mes}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0')}`;
};
const listaMeses = (ms: string[]) => ms.map(mesCorto).join(', ');

const ESTADO: Record<Lab['estado'], { texto: string; tone: Tone }> = {
  cubierto: { texto: 'Cubierto', tone: 'accent' },
  parcial: { texto: 'Parcial', tone: 'warn' },
  sin_compensacion: { texto: 'Sin compensación', tone: 'danger' },
  sin_precio_cero: { texto: 'Sin precio cero', tone: 'neutral' },
};

// Responsive: el contenido tope es max-w-6xl y desde lg el sidebar come 256 px.
// Clases literales: Tailwind purga las interpoladas.
const SOLO_MD = 'hidden md:table-cell';
const SOLO_XL = 'hidden xl:table-cell';

/** fetch → JSON que nunca rechaza: un 504 o la red caída no tumban la vista. */
async function pedir<T>(url: string): Promise<T | null> {
  const res = await fetch(url).catch(() => null);
  if (!res) return null;
  return (await res.json().catch(() => null)) as T | null;
}

type Preset = 'ultimo' | 'trimestre' | 'anio' | 'rango';

function rangoDePreset(p: Preset, disponibles: string[]): { desde: string; hasta: string } | null {
  if (!disponibles.length) return null;
  const ultimo = disponibles[disponibles.length - 1];
  if (p === 'ultimo') return { desde: ultimo, hasta: ultimo };
  if (p === 'trimestre') return { desde: disponibles[Math.max(0, disponibles.length - 3)], hasta: ultimo };
  return { desde: disponibles.find((m) => m.startsWith(ultimo.slice(0, 4))) ?? disponibles[0], hasta: ultimo };
}

const NIT_VALIDO = /^\d{5,15}$/;

function Detalle({
  l,
  desde,
  hasta,
  alPagarDisponible,
  mesesSinDatos,
}: {
  l: Lab;
  desde: string;
  hasta: string;
  alPagarDisponible: boolean;
  mesesSinDatos: string[];
}) {
  const fila = (k: string, v: string, hint?: string) => (
    <div className="flex items-baseline justify-between gap-4 border-b border-line py-1.5 last:border-0">
      <span className="text-ink-muted">
        {k}
        {hint && <span className="block text-[11px] text-ink-faint">{hint}</span>}
      </span>
      <span className="tabular text-ink">{v}</span>
    </div>
  );
  return (
    <div className="grid gap-6 bg-cream px-4 py-4 text-xs sm:text-sm md:grid-cols-2">
      <div>
        <div className="mb-1 font-medium text-ink">Lo que Jotagro regaló</div>
        {fila('Precio cero a costo', formatPrice(l.precioCero.costo))}
        {fila('Precio cero a precio de lista', formatPrice(l.precioCero.lista))}
        {fila('Unidades regaladas', miles(l.precioCero.unidades))}
        {fila('% de la venta del laboratorio', pctFmt(l.precioCero.pctVenta))}
        {fila('Margen real / sin precio cero', `${pctFmt(l.margenPct)} / ${pctFmt(l.margenSinPrecioCeroPct)}`)}
      </div>
      <div>
        <div className="mb-1 font-medium text-ink">Lo que devolvió el laboratorio</div>
        {fila('Mercancía gratis en compras', formatPrice(l.recibidoMercancia), `${miles(l.unidadesRecibidas)} und en facturas de compra + entradas por bonificados`)}
        {fila('Descuento en factura de compra', formatPrice(l.descuentoFacturaCompra))}
        {fila(
          'Descuento al pagar (14352290)',
          alPagarDisponible ? formatPrice(l.descuentoAlPagar) : 'Sin dato',
          alPagarDisponible ? undefined : 'El P&G de estos meses no está completo',
        )}
        {fila('Cobertura observada', pctFmt(l.cobertura))}
        {fila('Brecha', formatPrice(l.brecha))}
      </div>
      {l.precioCero.costo > 0 && NIT_VALIDO.test(l.nit) && (
        <div className="md:col-span-2">
          <a
            className="inline-flex items-center rounded border border-accent bg-accent px-3 py-1.5 text-xs font-medium text-ink-inverse transition-colors hover:bg-accent-dark"
            href={`/api/descuentos/reporte?nit=${encodeURIComponent(l.nit)}&desde=${desde}-01&hasta=${finDeMes(hasta)}`}
          >
            Descargar reporte precio cero (.xlsx)
          </a>
          <span className="ml-3 text-[11px] text-ink-faint">
            Facturas del periodo con sus líneas pagadas y regaladas, igual al Excel manual.
          </span>
          {mesesSinDatos.length > 0 && (
            <span className="mt-1 block text-[11px] text-warn">
              ⚠ Sin datos para {listaMeses(mesesSinDatos)}: el reporte saldrá incompleto y lo indica en su primera fila.
            </span>
          )}
        </div>
      )}
    </div>
  );
}

export default function DescuentosView() {
  const [data, setData] = useState<Resp | null>(null);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [preset, setPreset] = useState<Preset>('trimestre');
  const [rango, setRango] = useState<{ desde: string; hasta: string } | null>(null);
  const [disponibles, setDisponibles] = useState<string[]>([]);
  const [busqueda, setBusqueda] = useState('');
  const [soloP0, setSoloP0] = useState(true);
  const [abierto, setAbierto] = useState<string | null>(null);

  // Primera carga sin rango: trae los meses disponibles y fija el preset.
  useEffect(() => {
    let vigente = true;
    const url = rango ? `/api/descuentos?desde=${rango.desde}&hasta=${rango.hasta}` : '/api/descuentos';
    setCargando(true);
    pedir<Resp>(url).then((j) => {
      if (!vigente) return;
      if (!j) setError('No se pudo contactar al servidor');
      else if (j.ok === false) setError(j.mensaje ?? 'Error desconocido');
      else {
        setError(null);
        setDisponibles(j.mesesDisponibles);
        if (!rango) {
          const r = rangoDePreset('trimestre', j.mesesDisponibles);
          if (r && (r.desde !== j.desde || r.hasta !== j.hasta)) {
            setRango(r);
            return; // el efecto vuelve a correr con el rango
          }
        }
        setData(j);
      }
      setCargando(false);
    });
    return () => {
      vigente = false;
    };
  }, [rango]);

  const elegirPreset = (p: Preset) => {
    setPreset(p);
    setAbierto(null);
    if (p !== 'rango') {
      const r = rangoDePreset(p, disponibles);
      if (r) setRango(r);
    }
  };

  const labs = useMemo(() => {
    const q = busqueda.trim().toLowerCase();
    return (data?.labs ?? []).filter(
      (l) => (!soloP0 || l.precioCero.costo > 0) && (!q || l.nombre.toLowerCase().includes(q) || l.nit.includes(q)),
    );
  }, [data, busqueda, soloP0]);

  const t = data?.totales;
  // Sin ningún mes con P&G completo el canal "al pagar" no se conoce: se dice, no se pinta $ 0.
  const alPagarDisponible = (data?.alPagar.meses.length ?? 0) > 0;
  const desde = data?.desde ?? '';
  const hasta = data?.hasta ?? '';

  const subtitle = (
    <>
      {cargando && <span className="block">Cargando descuentos…</span>}
      {error && <span className="block text-danger">No se pudo cargar: {error}</span>}
      {data && data.meses.length > 0 && (
        <span className="tabular block text-xs text-ink-faint">
          {data.meses.length === 1 ? mesCorto(data.meses[0]) : `${mesCorto(data.meses[0])} a ${mesCorto(data.meses[data.meses.length - 1])}`} ·
          venta neta antes de IVA · costo de ventas de HGINet
        </span>
      )}
      {data?.incluyeMesAbierto && <span className="block text-xs text-warn">⚠ Incluye el mes en curso: sus cifras cambian hasta el cierre.</span>}
      {data && data.mesesSinDatos.length > 0 && (
        <span className="block text-xs text-warn">⚠ Sin datos todavía para {listaMeses(data.mesesSinDatos)}: las cifras no los incluyen.</span>
      )}
      {data && data.alPagar.mesesSinDato.length > 0 && (
        <span className="block text-xs text-warn">
          ⚠ El descuento al pagar no está disponible para {listaMeses(data.alPagar.mesesSinDato)} (el P&amp;G de esos meses no está
          completo); la cobertura de esos meses puede verse más baja de lo real.
        </span>
      )}
    </>
  );

  return (
    <div className="space-y-8">
      <PageHeader title="Descuentos diferenciados" subtitle={subtitle} />

      {disponibles.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <FilterButton active={preset === 'ultimo'} onClick={() => elegirPreset('ultimo')}>
            Último mes
          </FilterButton>
          <FilterButton active={preset === 'trimestre'} onClick={() => elegirPreset('trimestre')}>
            Últimos 3 meses
          </FilterButton>
          <FilterButton active={preset === 'anio'} onClick={() => elegirPreset('anio')}>
            Año
          </FilterButton>
          <FilterButton active={preset === 'rango'} onClick={() => elegirPreset('rango')}>
            Rango
          </FilterButton>
          {preset === 'rango' && rango && (
            <span className="flex items-center gap-2 text-sm text-ink-muted">
              <label className="sr-only" htmlFor="dd-desde">Desde</label>
              <select
                id="dd-desde"
                className="rounded border border-line bg-surface px-2 py-1.5 text-sm text-ink"
                value={rango.desde}
                onChange={(e) => setRango({ desde: e.target.value, hasta: e.target.value > rango.hasta ? e.target.value : rango.hasta })}
              >
                {disponibles.map((m) => (
                  <option key={m} value={m}>{mesCorto(m)}</option>
                ))}
              </select>
              a
              <label className="sr-only" htmlFor="dd-hasta">Hasta</label>
              <select
                id="dd-hasta"
                className="rounded border border-line bg-surface px-2 py-1.5 text-sm text-ink"
                value={rango.hasta}
                onChange={(e) => setRango({ desde: e.target.value < rango.desde ? e.target.value : rango.desde, hasta: e.target.value })}
              >
                {disponibles.map((m) => (
                  <option key={m} value={m}>{mesCorto(m)}</option>
                ))}
              </select>
            </span>
          )}
        </div>
      )}

      {data && !t && !cargando && (
        <Card>
          <EmptyState title="Todavía no hay meses ingestados" hint="El cron de descuentos los va cargando del más reciente al más viejo." />
        </Card>
      )}

      {t && (
        <>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <KpiCard label="Venta neta" {...kpiMoney(t.ventaNeta)} />
            <KpiCard
              label="Precio cero entregado"
              {...kpiMoney(t.precioCeroCosto)}
              tone="warn"
              delta={`${pctFmt(t.precioCeroPctVenta)} de la venta, a costo`}
              hint={`${t.labsConPrecioCero} laboratorios`}
            />
            <KpiCard
              label="Margen bruto"
              value={pctFmt(t.margenPct)}
              tone="accent"
              delta={`${pctFmt(t.margenSinPrecioCeroPct)} sin el precio cero`}
            />
            <KpiCard
              label="Brecha por cobrar"
              {...kpiMoney(t.brecha)}
              tone={t.brecha > 0 ? 'danger' : 'neutral'}
              hint={`${t.labsConBrecha} laboratorios con brecha`}
            />
          </div>

          <section className="space-y-3">
            <SectionTitle>Lo que devolvieron los laboratorios</SectionTitle>
            <div className="grid gap-4 sm:grid-cols-3">
              <KpiCard label="Mercancía gratis en compras" {...kpiMoney(t.recibidoMercancia)} hint="Unidades gratis en facturas de compra y entradas por bonificados" />
              <KpiCard label="Descuento en factura de compra" {...kpiMoney(t.descuentoFacturaCompra)} hint="Puede incluir descuentos comerciales normales" />
              {alPagarDisponible ? (
                <KpiCard label="Descuento al pagar" {...kpiMoney(t.descuentoAlPagar)} hint="Cuenta 14352290, sólo meses con P&G completo" />
              ) : (
                <KpiCard label="Descuento al pagar" value="Sin dato" hint="El P&G de los meses elegidos no está completo (cuenta 14352290)" />
              )}
            </div>
          </section>

          <section className="space-y-3">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
              <SectionTitle>Por laboratorio</SectionTitle>
              <div className="flex flex-wrap items-center gap-2">
                <input
                  type="search"
                  value={busqueda}
                  onChange={(e) => setBusqueda(e.target.value)}
                  placeholder="Buscar laboratorio o NIT"
                  aria-label="Buscar laboratorio o NIT"
                  className="w-56 rounded border border-line bg-surface px-3 py-1.5 text-sm text-ink placeholder:text-ink-faint"
                />
                <FilterButton active={soloP0} onClick={() => setSoloP0(!soloP0)}>
                  Sólo con precio cero
                </FilterButton>
              </div>
            </div>
            <Card>
              <div className="overflow-x-auto">
                <table className="w-full text-xs sm:text-sm">
                  <thead className="bg-surface-muted">
                    <tr>
                      <Th>Laboratorio</Th>
                      <Th align="right">Precio cero</Th>
                      <Th align="right" className={SOLO_MD}>% venta</Th>
                      <Th align="right" className={SOLO_XL}>Margen</Th>
                      <Th align="right" className={SOLO_XL}>Sin precio cero</Th>
                      <Th align="right" className={SOLO_MD}>Devuelto</Th>
                      <Th align="right">Brecha</Th>
                      <Th align="center" className={SOLO_MD}>Estado</Th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line">
                    {labs.map((l) => {
                      const open = abierto === l.nit;
                      return (
                        <Fragment key={l.nit}>
                          <tr
                            className="cursor-pointer transition-colors hover:bg-surface-hover"
                            onClick={() => setAbierto(open ? null : l.nit)}
                            aria-expanded={open}
                          >
                            <td className="px-4 py-3">
                              <div className="font-medium text-ink">{l.nombre}</div>
                              <div className="tabular text-[11px] text-ink-faint">NIT {l.nit}</div>
                              <div className="mt-1 md:hidden">
                                <Badge tone={ESTADO[l.estado].tone}>{ESTADO[l.estado].texto}</Badge>
                              </div>
                            </td>
                            <td className="tabular px-4 py-3 text-right text-ink">{formatPrice(l.precioCero.costo)}</td>
                            <td className={`tabular px-4 py-3 text-right text-ink-muted ${SOLO_MD}`}>{pctFmt(l.precioCero.pctVenta)}</td>
                            <td className={`tabular px-4 py-3 text-right ${(l.margenPct ?? 0) < 0 ? 'text-danger' : 'text-ink'} ${SOLO_XL}`}>{pctFmt(l.margenPct)}</td>
                            <td className={`tabular px-4 py-3 text-right text-ink-muted ${SOLO_XL}`}>{pctFmt(l.margenSinPrecioCeroPct)}</td>
                            <td className={`tabular px-4 py-3 text-right text-ink ${SOLO_MD}`}>{formatPrice(l.compensacionObservada)}</td>
                            <td className={`tabular px-4 py-3 text-right ${l.brecha > 0 ? 'font-medium text-danger' : 'text-ink-faint'}`}>
                              {l.brecha > 0 ? formatPrice(l.brecha) : '—'}
                            </td>
                            <td className={`px-4 py-3 text-center ${SOLO_MD}`}>
                              <Badge tone={ESTADO[l.estado].tone}>{ESTADO[l.estado].texto}</Badge>
                            </td>
                          </tr>
                          {open && (
                            <tr>
                              <td colSpan={8} className="p-0">
                                <Detalle l={l} desde={desde} hasta={hasta} alPagarDisponible={alPagarDisponible} mesesSinDatos={data?.mesesSinDatos ?? []} />
                              </td>
                            </tr>
                          )}
                        </Fragment>
                      );
                    })}
                  </tbody>
                </table>
                {labs.length === 0 && <EmptyState title="Ningún laboratorio coincide" />}
              </div>
            </Card>
            <p className="text-xs text-ink-faint">
              Toque un laboratorio para ver el detalle y descargar su reporte. <strong className="font-medium">Devuelto</strong> suma
              mercancía gratis, descuento en factura de compra y descuento al pagar; los descuentos pueden incluir condiciones
              comerciales normales, por eso la cobertura es «observada». <strong className="font-medium">Cubierto</strong> = lo devuelto
              llega al 95 % del precio cero a costo.
            </p>
          </section>
        </>
      )}
    </div>
  );
}
