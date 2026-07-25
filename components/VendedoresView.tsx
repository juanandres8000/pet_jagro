'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { PageHeader, SectionTitle, KpiCard, Card, Th, EmptyState, FilterButton, Badge } from '@/components/ui';
import { formatPrice, kpiMoney } from '@/lib/format';

/**
 * Rendimiento por vendedor + comportamiento de pago + próximos vencimientos.
 *
 * No agrega nada: todo llega resuelto de /api/vendedores. El detalle de una
 * ventana de vencimiento es otra llamada paginada.
 *
 * DOS MAGNITUDES SEPARADAS A PROPÓSITO
 * "Recaudado en el periodo" es un FLUJO del mes (snapshot de recaudo). "Saldo
 * abierto" es una FOTO de hoy (snapshot de cartera). Van en bloques distintos,
 * con encabezado de grupo y nota, porque restar uno del otro no significa nada.
 * Mismo criterio que los saldos a favor en Cartera.
 */

const miles = (n: number) => n.toLocaleString('es-CO');
const pct = (v: number) => `${(v * 100).toFixed(1)}%`;

type Orden = 'recaudado' | 'saldoAbierto' | 'operaciones' | 'nombre' | 'ticket';

interface FilaVendedor {
  codigoVendedor: string;
  nombre: string;
  recaudado: number;
  operaciones: number;
  tercerosRecaudo: number;
  ticketPromedio: number;
  ajustes: number;
  opsAjustes: number;
  saldoAbierto: number;
  saldoVencido: number;
  docsAbiertos: number;
  tercerosCartera: number;
}

interface BucketMora {
  clave: string;
  label: string;
  operaciones: number;
  valor: number;
}

interface Ventana {
  clave: string;
  label: string;
  docs: number;
  valor: number;
}

interface DocFila {
  documento: string;
  transaccion: string;
  cuota: string;
  codigoTercero: string;
  nombreTercero: string;
  codigoVendedor: string;
  nombreVendedor: string;
  fechaVencimiento: string;
  diasParaVencer: number;
  saldo: number;
}

interface Respuesta {
  ok: boolean;
  mensaje?: string;
  avisos?: string[];
  periodo?: { desde: string; hasta: string } | null;
  builtAt?: { recaudo: string | null; cartera: string | null };
  horizonteProximosDias?: number | null;
  vendedores?: FilaVendedor[];
  totales?: {
    recaudado: number;
    operaciones: number;
    ajustes: number;
    opsAjustes: number;
    saldoAbierto: number;
    saldoVencido: number;
    docsAbiertos: number;
  } | null;
  comportamiento?: {
    buckets: BucketMora[];
    total: { operaciones: number; valor: number };
    sinVencimiento: number;
    peor: { dias: number; tercero: string; valor: number };
    moraPromedio: number;
    opsEnMora: number;
  } | null;
  proximos?: { ventanas: Ventana[]; totalDocs: number } | null;
  ventana?: string;
  detalle?: { page: number; pageSize: number; total: number; valor: number; filas: DocFila[] };
}

/** Barras de distribución de mora. Los "pagó antes" van en acento, la mora escala a rojo. */
const TONO_BUCKET: Record<string, string> = {
  antes: 'bg-accent',
  alDia: 'bg-accent-light',
  '1-30': 'bg-warn/60',
  '31-90': 'bg-warn',
  '90+': 'bg-danger',
};

export default function VendedoresView() {
  const [d, setD] = useState<Respuesta | null>(null);
  const [orden, setOrden] = useState<Orden>('saldoAbierto');
  const [ventana, setVentana] = useState<string | null>(null);
  const [detalle, setDetalle] = useState<Respuesta['detalle'] | null>(null);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [cargandoDet, setCargandoDet] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // .catch(() => null) sobre el FETCH, no sólo sobre el .json().
  const pedir = useCallback(async (url: string): Promise<Respuesta | null> => {
    const res = await fetch(url).catch(() => null);
    if (!res) return null;
    return (await res.json().catch(() => null)) as Respuesta | null;
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const j = await pedir('/api/vendedores');
      if (cancelled) return;
      if (!j) setError('No se pudo contactar al servidor');
      else {
        setError(j.ok === false ? j.mensaje ?? 'Error desconocido' : null);
        setD(j);
      }
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [pedir]);

  useEffect(() => setPage(1), [ventana]);

  useEffect(() => {
    if (!ventana) {
      setDetalle(null);
      return;
    }
    let cancelled = false;
    (async () => {
      setCargandoDet(true);
      const j = await pedir(`/api/vendedores?proximos=${encodeURIComponent(ventana)}&page=${page}`);
      // Un detalle que falla no borra la vista: se queda lo anterior.
      if (!cancelled && j?.detalle) setDetalle(j.detalle);
      if (!cancelled) setCargandoDet(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [ventana, page, pedir]);

  const vendedores = useMemo(() => {
    const arr = [...(d?.vendedores ?? [])];
    const cmp: Record<Orden, (a: FilaVendedor, b: FilaVendedor) => number> = {
      recaudado: (a, b) => b.recaudado - a.recaudado,
      saldoAbierto: (a, b) => b.saldoAbierto - a.saldoAbierto,
      operaciones: (a, b) => b.operaciones - a.operaciones,
      ticket: (a, b) => b.ticketPromedio - a.ticketPromedio,
      nombre: (a, b) => a.nombre.localeCompare(b.nombre, 'es'),
    };
    return arr.sort(cmp[orden]);
  }, [d?.vendedores, orden]);

  const t = d?.totales;
  const comp = d?.comportamiento;
  const maxOps = Math.max(1, ...(comp?.buckets ?? []).map((b) => b.operaciones));
  const totalPaginas = detalle ? Math.max(1, Math.ceil(detalle.total / detalle.pageSize)) : 1;

  const subtitle = (
    <>
      {loading && <span className="block">Calculando rendimiento por vendedor…</span>}
      {error && <span className="block text-danger">No se pudo cargar: {error}</span>}
      {(d?.avisos ?? []).map((a) => (
        <span key={a} className="block text-warn">
          ⚠ {a}
        </span>
      ))}
      {!loading && !error && d?.periodo && (
        <span className="tabular block text-xs text-ink-faint">
          Recaudo del periodo {d.periodo.desde} → {d.periodo.hasta} · cartera a hoy
          {d.builtAt?.cartera ? ` · actualizado ${new Date(d.builtAt.cartera).toLocaleString('es-CO')}` : ''}
        </span>
      )}
    </>
  );

  return (
    <div className="space-y-8">
      <PageHeader title="Vendedores" subtitle={subtitle} />

      <section className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <KpiCard label="Recaudado del periodo" {...kpiMoney(t?.recaudado ?? 0)} tone="accent" hint={`${miles(t?.operaciones ?? 0)} operaciones`} />
        <KpiCard
          label="Ajustes del periodo"
          {...kpiMoney(t?.ajustes ?? 0)}
          tone="warn"
          hint={`${miles(t?.opsAjustes ?? 0)} descuentos y notas · NO son caja`}
        />
        <KpiCard label="Saldo abierto (hoy)" {...kpiMoney(t?.saldoAbierto ?? 0)} hint={`${miles(t?.docsAbiertos ?? 0)} documentos`} />
        <KpiCard
          label="Vencido (hoy)"
          {...kpiMoney(t?.saldoVencido ?? 0)}
          tone="danger"
          hint={t && t.saldoAbierto > 0 ? `${pct(t.saldoVencido / t.saldoAbierto)} del saldo abierto` : undefined}
        />
      </section>

      {/* Frente 1 — ranking */}
      <section className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <SectionTitle>Rendimiento por vendedor</SectionTitle>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs uppercase tracking-wider text-ink-muted">Ordenar</span>
            <FilterButton active={orden === 'saldoAbierto'} onClick={() => setOrden('saldoAbierto')}>
              Saldo
            </FilterButton>
            <FilterButton active={orden === 'recaudado'} onClick={() => setOrden('recaudado')}>
              Recaudado
            </FilterButton>
            <FilterButton active={orden === 'operaciones'} onClick={() => setOrden('operaciones')}>
              Operaciones
            </FilterButton>
            <FilterButton active={orden === 'ticket'} onClick={() => setOrden('ticket')}>
              Ticket
            </FilterButton>
            <FilterButton active={orden === 'nombre'} onClick={() => setOrden('nombre')}>
              Nombre
            </FilterButton>
          </div>
        </div>

        <p className="text-xs leading-relaxed text-ink-muted">
          Las dos mitades de la tabla miden cosas distintas y no se restan.{' '}
          <span className="text-ink">Recaudo del periodo</span> es un flujo del mes, del snapshot de recaudo.{' '}
          <span className="text-ink">Cartera a hoy</span> es una foto del saldo pendiente, de otra consulta del ERP.
          Un vendedor puede recaudar mucho y seguir con saldo alto, o al contrario.
        </p>

        <Card className="overflow-hidden">
          {!vendedores.length ? (
            <EmptyState title={loading ? 'Cargando…' : 'Sin vendedores'} />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[980px] text-sm">
                <thead>
                  {/* Encabezado de grupo: deja claro de dónde sale cada mitad. */}
                  <tr className="border-b border-line bg-surface">
                    <th className="px-4 py-2" />
                    <th
                      colSpan={4}
                      className="border-l border-line px-4 py-2 text-left text-[11px] font-semibold uppercase tracking-wider text-accent"
                    >
                      Recaudo del periodo · flujo
                    </th>
                    <th
                      colSpan={3}
                      className="border-l border-line px-4 py-2 text-left text-[11px] font-semibold uppercase tracking-wider text-ink-muted"
                    >
                      Cartera a hoy · foto
                    </th>
                  </tr>
                  <tr className="bg-surface-muted">
                    <Th>Vendedor</Th>
                    <Th align="right">Recaudado</Th>
                    <Th align="center">Ops.</Th>
                    <Th align="right">Ticket prom.</Th>
                    <Th align="right">Ajustes</Th>
                    <Th align="right">Saldo abierto</Th>
                    <Th align="right">Vencido</Th>
                    <Th align="center">Docs</Th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {vendedores.map((v) => (
                    <tr key={v.codigoVendedor} className="hover:bg-surface-hover">
                      <td className="px-4 py-2.5">
                        <div className="text-ink">{v.nombre}</div>
                        <div className="tabular mt-0.5 font-mono text-[11px] text-ink-faint">
                          {v.codigoVendedor} · {miles(v.tercerosRecaudo)} terceros con pago · {miles(v.tercerosCartera)} con saldo
                        </div>
                      </td>
                      <td className="tabular whitespace-nowrap border-l border-line px-4 py-2.5 text-right font-medium text-accent">
                        {formatPrice(v.recaudado)}
                      </td>
                      <td className="tabular px-4 py-2.5 text-center text-ink-muted">{miles(v.operaciones)}</td>
                      <td className="tabular whitespace-nowrap px-4 py-2.5 text-right text-ink">{formatPrice(v.ticketPromedio)}</td>
                      <td className="tabular whitespace-nowrap px-4 py-2.5 text-right">
                        {v.ajustes !== 0 ? (
                          <span className="text-warn" title={`${miles(v.opsAjustes)} descuentos y notas`}>
                            {formatPrice(v.ajustes)}
                          </span>
                        ) : (
                          <span className="text-ink-faint">—</span>
                        )}
                      </td>
                      <td className="tabular whitespace-nowrap border-l border-line px-4 py-2.5 text-right font-medium text-ink">
                        {formatPrice(v.saldoAbierto)}
                      </td>
                      <td className="tabular whitespace-nowrap px-4 py-2.5 text-right text-danger">
                        {formatPrice(v.saldoVencido)}
                      </td>
                      <td className="tabular px-4 py-2.5 text-center text-ink-muted">{miles(v.docsAbiertos)}</td>
                    </tr>
                  ))}
                </tbody>
                {t && (
                  <tfoot>
                    <tr className="border-t-2 border-line-strong bg-surface-muted font-medium">
                      <td className="px-4 py-3 text-ink">Total ({vendedores.length})</td>
                      <td className="tabular whitespace-nowrap border-l border-line px-4 py-3 text-right text-accent">
                        {formatPrice(t.recaudado)}
                      </td>
                      <td className="tabular px-4 py-3 text-center text-ink">{miles(t.operaciones)}</td>
                      <td className="tabular px-4 py-3 text-right text-ink-faint">—</td>
                      <td className="tabular whitespace-nowrap px-4 py-3 text-right text-warn">{formatPrice(t.ajustes)}</td>
                      <td className="tabular whitespace-nowrap border-l border-line px-4 py-3 text-right text-ink">
                        {formatPrice(t.saldoAbierto)}
                      </td>
                      <td className="tabular whitespace-nowrap px-4 py-3 text-right text-danger">
                        {formatPrice(t.saldoVencido)}
                      </td>
                      <td className="tabular px-4 py-3 text-center text-ink">{miles(t.docsAbiertos)}</td>
                    </tr>
                  </tfoot>
                )}
              </table>
            </div>
          )}
        </Card>
      </section>

      {/* Frente 2a — comportamiento de pago */}
      <section className="space-y-3">
        <SectionTitle>Comportamiento de pago</SectionTitle>
        <Card className="overflow-hidden">
          {!comp || !comp.total.operaciones ? (
            <EmptyState title={loading ? 'Cargando…' : 'Sin operaciones de recaudo con vencimiento'} />
          ) : (
            <>
              <p className="border-b border-line px-6 py-3 text-xs leading-relaxed text-ink-muted">
                Distribución, no promedio. La mora media de las{' '}
                <span className="tabular text-ink">{miles(comp.opsEnMora)}</span> operaciones que pagaron tarde es de{' '}
                <span className="tabular text-ink">{comp.moraPromedio.toFixed(1)} días</span>, pero el máximo es de{' '}
                <span className="tabular text-danger">{miles(comp.peor.dias)} días</span>: la media no describe nada
                cuando la cola es así de larga.
              </p>
              <div className="space-y-3 p-6">
                {comp.buckets.map((b) => (
                  <div key={b.clave} className="flex items-center gap-3">
                    <div className="w-28 shrink-0 text-right text-xs font-medium text-ink-muted">{b.label}</div>
                    <div className="h-6 flex-1 overflow-hidden rounded bg-surface-muted">
                      <div
                        className={`h-full rounded ${TONO_BUCKET[b.clave] ?? 'bg-accent'}`}
                        style={{ width: `${Math.max((b.operaciones / maxOps) * 100, b.operaciones > 0 ? 2 : 0)}%` }}
                      />
                    </div>
                    <div className="tabular w-52 shrink-0 text-right text-xs text-ink">
                      {miles(b.operaciones)} ops
                      <span className="ml-1 text-ink-faint">({pct(b.operaciones / comp.total.operaciones)})</span>
                      <span className="ml-2 text-ink-muted">{formatPrice(b.valor)}</span>
                    </div>
                  </div>
                ))}
              </div>
              <div className="flex flex-wrap items-center gap-x-6 gap-y-1 border-t border-line px-6 py-3 text-xs text-ink-muted">
                <span className="tabular">
                  Total {miles(comp.total.operaciones)} operaciones · {formatPrice(comp.total.valor)}
                </span>
                {comp.sinVencimiento > 0 && (
                  <span className="text-warn">{miles(comp.sinVencimiento)} sin fecha de vencimiento, excluidas</span>
                )}
                <span className="text-ink-faint">Sólo recaudo real; los ajustes no entran</span>
              </div>
            </>
          )}
        </Card>
      </section>

      {/* Frente 2b — próximos vencimientos */}
      <section className="space-y-3">
        <SectionTitle>Próximos vencimientos</SectionTitle>
        <Card className="overflow-hidden">
          {!d?.proximos?.ventanas.length ? (
            <EmptyState title={loading ? 'Cargando…' : 'Sin documentos por vencer'} />
          ) : (
            <>
              <div className="grid grid-cols-1 divide-y divide-line sm:grid-cols-2 sm:divide-y-0 lg:grid-cols-4 lg:divide-x">
                {d.proximos.ventanas.map((v) => (
                  <button
                    key={v.clave}
                    onClick={() => setVentana(ventana === v.clave ? null : v.clave)}
                    className={`p-6 text-left transition-colors hover:bg-surface-hover ${
                      ventana === v.clave ? 'bg-surface-hover' : ''
                    }`}
                  >
                    <div className="text-xs font-medium uppercase tracking-wider text-ink-muted">{v.label}</div>
                    <div className="tabular mt-2 font-serif text-2xl font-semibold text-ink" title={formatPrice(v.valor)}>
                      {kpiMoney(v.valor).value}
                    </div>
                    <div className="tabular mt-1 text-xs text-ink-faint">{miles(v.docs)} documentos</div>
                    <div className="mt-2 text-xs text-accent">{ventana === v.clave ? 'Ocultar detalle' : 'Ver detalle →'}</div>
                  </button>
                ))}
              </div>
              <p className="border-t border-line px-6 py-3 text-xs text-ink-muted">
                Ventanas acumulativas. Sólo documentos aún no vencidos, con saldo pendiente; horizonte de{' '}
                {d.horizonteProximosDias ?? 45} días.
              </p>
            </>
          )}
        </Card>
      </section>

      {/* Detalle por documento de la ventana elegida */}
      {ventana && detalle && (
        <section className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <SectionTitle>
              Documentos · {d?.proximos?.ventanas.find((v) => v.clave === ventana)?.label ?? ventana}
            </SectionTitle>
            <button
              onClick={() => setVentana(null)}
              className="rounded border border-line px-3 py-1.5 text-sm text-ink-muted transition-colors hover:bg-surface-hover hover:text-ink"
            >
              Cerrar
            </button>
          </div>
          <Card className="overflow-hidden">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-3">
              <p className="tabular text-xs text-ink-muted">
                {miles(detalle.total)} documentos · {formatPrice(detalle.valor)} · página {detalle.page} de{' '}
                {totalPaginas}
                {cargandoDet ? ' · actualizando…' : ''}
              </p>
              <div className="flex items-center gap-1.5">
                <button
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  disabled={detalle.page <= 1 || cargandoDet}
                  className="rounded border border-line px-2.5 py-1 text-sm text-ink-muted transition-colors hover:bg-surface-hover hover:text-ink disabled:opacity-40"
                >
                  ←
                </button>
                <button
                  onClick={() => setPage((p) => Math.min(totalPaginas, p + 1))}
                  disabled={detalle.page >= totalPaginas || cargandoDet}
                  className="rounded border border-line px-2.5 py-1 text-sm text-ink-muted transition-colors hover:bg-surface-hover hover:text-ink disabled:opacity-40"
                >
                  →
                </button>
              </div>
            </div>
            {!detalle.filas.length ? (
              <EmptyState title="Sin documentos en esta ventana" />
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[820px] text-sm">
                  <thead className="bg-surface-muted">
                    <tr>
                      <Th>Documento</Th>
                      <Th>Tercero</Th>
                      <Th>Vendedor</Th>
                      <Th align="center">Vence</Th>
                      <Th align="right">Saldo</Th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line">
                    {detalle.filas.map((f) => (
                      <tr
                        key={`${f.transaccion}-${f.documento}-${f.cuota}-${f.codigoTercero}`}
                        className="hover:bg-surface-hover"
                      >
                        <td className="px-4 py-2.5">
                          <div className="tabular font-mono text-xs text-ink">{f.documento}</div>
                          <div className="tabular mt-0.5 text-[11px] text-ink-faint">
                            transacción {f.transaccion}
                            {f.cuota ? ` · cuota ${f.cuota}` : ''}
                          </div>
                        </td>
                        <td className="px-4 py-2.5">
                          <div className="max-w-[20rem] truncate text-ink" title={f.nombreTercero}>
                            {f.nombreTercero}
                          </div>
                          <div className="tabular mt-0.5 font-mono text-[11px] text-ink-faint">{f.codigoTercero}</div>
                        </td>
                        <td className="px-4 py-2.5 text-xs text-ink-muted">{f.nombreVendedor}</td>
                        <td className="px-4 py-2.5 text-center">
                          <div className="tabular text-xs text-ink">{f.fechaVencimiento}</div>
                          <div className="mt-0.5">
                            <Badge tone={f.diasParaVencer <= 7 ? 'warn' : 'neutral'}>
                              {f.diasParaVencer === 0 ? 'hoy' : `${f.diasParaVencer} d`}
                            </Badge>
                          </div>
                        </td>
                        <td className="tabular whitespace-nowrap px-4 py-2.5 text-right font-medium text-ink">
                          {formatPrice(f.saldo)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </section>
      )}
    </div>
  );
}
