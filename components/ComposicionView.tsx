'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ClaseSaldo, GrupoSaldo } from '@/lib/hgi/mappers/clases';
import { PageHeader, SectionTitle, KpiCard, Card, Th, EmptyState, Badge, FilterButton } from '@/components/ui';
import { formatPrice, kpiMoney } from '@/lib/format';

/**
 * Composición de cartera por clase de documento (Api/Cartera/ResumenPorClases).
 *
 * No calcula agregados: llegan resueltos de /api/clases, que los computa en el
 * lambda. El drill a terceros de una clase es otra llamada paginada, no un
 * filtrado en el browser sobre el dataset completo.
 *
 * DOS REGLAS QUE SE VEN EN ESTA VISTA:
 * - Los saldos negativos (anticipos y notas a favor del tercero) se MUESTRAN.
 *   Por eso el gráfico es de barras divergentes con línea base en cero, y no uno
 *   de proporciones tipo dona: un negativo no tiene "porcentaje del total".
 * - No hay selector de tipo de cartera: sólo el 0 (General) tiene datos en esta
 *   instancia, así que sería un control muerto. Ver mappers/clases.ts.
 */

const miles = (n: number) => n.toLocaleString('es-CO');

type Orden = 'saldo' | 'nombre' | 'terceros';

interface Respuesta {
  ok: boolean;
  anyo: number | null;
  porClase?: GrupoSaldo[];
  porBanco?: GrupoSaldo[];
  bancoDiscrimina?: boolean;
  totalSaldo?: number;
  totalPositivo?: number;
  totalNegativo?: number;
  terceros?: number;
  filas?: number;
  cached?: boolean;
  stale?: boolean;
  built_at?: string;
  aviso?: string;
  rebuildError?: string;
}

interface RespuestaDrill extends Respuesta {
  clase?: string;
  nombreClase?: string;
  grupo?: GrupoSaldo | null;
  terceros_?: never;
  tercerosPag?: never;
}

interface Drill {
  clase: string;
  nombreClase: string;
  grupo: GrupoSaldo | null;
  page: number;
  pageSize: number;
  total: number;
  filas: ClaseSaldo[];
}

/**
 * Barras divergentes horizontales con eje en cero.
 *
 * El eje se coloca según cuánto negativo haya: sin negativos queda pegado a la
 * izquierda y el gráfico se lee como barras normales. Nunca se usa Math.abs para
 * "hacer que quepa" un negativo — se le da su lado del eje.
 */
function BarrasDivergentes({
  grupos,
  onClick,
  seleccion,
}: {
  grupos: GrupoSaldo[];
  onClick?: (codigo: string) => void;
  seleccion?: string | null;
}) {
  if (!grupos.length) return <EmptyState title="Sin clases en el periodo" />;

  const maxPos = Math.max(0, ...grupos.map((g) => g.saldo));
  const maxNeg = Math.max(0, ...grupos.map((g) => -g.saldo));
  const span = maxPos + maxNeg || 1;
  const ejePct = (maxNeg / span) * 100;

  return (
    <div className="space-y-1 p-4">
      {grupos.map((g) => {
        const neg = g.saldo < 0;
        const anchoPct = (Math.abs(g.saldo) / span) * 100;
        const activo = seleccion === g.codigo;
        return (
          <button
            key={g.codigo}
            onClick={onClick ? () => onClick(g.codigo) : undefined}
            disabled={!onClick}
            className={`block w-full rounded px-2 py-1.5 text-left transition-colors ${
              onClick ? 'hover:bg-surface-hover' : ''
            } ${activo ? 'bg-surface-hover' : ''}`}
            title={`${g.nombre} · saldo ${formatPrice(g.saldo)} · ${miles(g.terceros)} terceros${
              g.enNegativo ? ` · ${miles(g.enNegativo)} en negativo` : ''
            }`}
          >
            <div className="flex items-baseline justify-between gap-3">
              <span className={`truncate text-sm ${activo ? 'font-medium text-ink' : 'text-ink'}`}>{g.nombre}</span>
              <span className={`tabular whitespace-nowrap text-xs ${neg ? 'text-danger' : 'text-ink-muted'}`}>
                {formatPrice(g.saldo)}
              </span>
            </div>
            <div className="relative mt-1 h-2.5 w-full rounded bg-surface-muted">
              {/* Eje de cero: sólo se dibuja si hay negativos que lo justifiquen. */}
              {maxNeg > 0 && (
                <div className="absolute inset-y-0 w-px bg-line-strong" style={{ left: `${ejePct}%` }} />
              )}
              <div
                className={`absolute inset-y-0 rounded ${neg ? 'bg-danger' : 'bg-accent'}`}
                style={
                  neg
                    ? { right: `${100 - ejePct}%`, width: `${Math.max(0.4, anchoPct)}%` }
                    : { left: `${ejePct}%`, width: `${Math.max(0.4, anchoPct)}%` }
                }
              />
            </div>
          </button>
        );
      })}
      <div className="flex flex-wrap items-center gap-4 border-t border-line px-2 pt-3 text-xs text-ink-muted">
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-2.5 rounded-sm bg-accent" /> Saldo por cobrar
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-2.5 rounded-sm bg-danger" /> Saldo a favor del tercero
        </span>
      </div>
    </div>
  );
}

export default function ComposicionView() {
  const [d, setD] = useState<Respuesta | null>(null);
  const [drill, setDrill] = useState<Drill | null>(null);
  const [orden, setOrden] = useState<Orden>('saldo');
  const [loading, setLoading] = useState(true);
  const [cargandoDrill, setCargandoDrill] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // .catch(() => null) sobre el FETCH, no sólo sobre el .json(): un fetch que
  // rechaza (504 que corta la conexión, red caída) no debe tumbar la vista.
  const pedir = useCallback(async (url: string) => {
    const res = await fetch(url).catch(() => null);
    if (!res) return { error: 'No se pudo contactar al servidor' as const };
    const json = (await res.json().catch(() => null)) as Respuesta | null;
    if (!json) return { error: `Respuesta ilegible (HTTP ${res.status})` as const };
    return { json };
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const r = await pedir('/api/clases');
      if (cancelled) return;
      if ('error' in r && r.error) setError(r.error);
      else if (r.json) {
        setError(null);
        setD(r.json);
      }
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [pedir]);

  const abrirDrill = useCallback(
    async (clase: string, page = 1) => {
      setCargandoDrill(true);
      const r = await pedir(`/api/clases?clase=${encodeURIComponent(clase)}&page=${page}`);
      if ('json' in r && r.json) {
        const j = r.json as RespuestaDrill & { terceros?: { page: number; pageSize: number; total: number; filas: ClaseSaldo[] } };
        if (j.terceros) {
          setDrill({
            clase: j.clase ?? clase,
            nombreClase: j.nombreClase ?? clase,
            grupo: j.grupo ?? null,
            page: j.terceros.page,
            pageSize: j.terceros.pageSize,
            total: j.terceros.total,
            filas: j.terceros.filas,
          });
        }
      }
      // Un drill que falla no borra la vista: se queda el panel anterior.
      setCargandoDrill(false);
    },
    [pedir],
  );

  const clases = useMemo(() => {
    const arr = [...(d?.porClase ?? [])];
    if (orden === 'nombre') arr.sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'));
    else if (orden === 'terceros') arr.sort((a, b) => b.terceros - a.terceros);
    else arr.sort((a, b) => b.saldo - a.saldo);
    return arr;
  }, [d?.porClase, orden]);

  const totalPaginasDrill = drill ? Math.max(1, Math.ceil(drill.total / drill.pageSize)) : 1;

  const subtitle = (
    <>
      {loading && <span className="block">Cargando composición de cartera…</span>}
      {error && <span className="block text-danger">No se pudo cargar: {error}</span>}
      {d?.aviso && <span className="block text-warn">⚠ {d.aviso}</span>}
      {d?.rebuildError && <span className="block text-warn">⚠ Datos en caché: {d.rebuildError}</span>}
      {!loading && !error && d && !d.aviso && (
        <span className="tabular block text-xs text-ink-faint">
          Ejercicio {d.anyo} · {miles(d.filas ?? 0)} registros · {miles(d.terceros ?? 0)} terceros
          {d.stale ? ' · caché (reintentando actualización)' : ''}
          {d.built_at ? ` · actualizado ${new Date(d.built_at).toLocaleString('es-CO')}` : ''}
        </span>
      )}
    </>
  );

  return (
    <div className="space-y-8">
      <PageHeader title="Composición de cartera" subtitle={subtitle} />

      <section className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <KpiCard label="Saldo total" {...kpiMoney(d?.totalSaldo ?? 0)} tone={(d?.totalSaldo ?? 0) < 0 ? 'danger' : 'neutral'} />
        <KpiCard label="Por cobrar" {...kpiMoney(d?.totalPositivo ?? 0)} tone="accent" hint="Suma de los saldos positivos" />
        <KpiCard
          label="A favor del tercero"
          {...kpiMoney(d?.totalNegativo ?? 0)}
          tone={(d?.totalNegativo ?? 0) < 0 ? 'danger' : 'neutral'}
          hint="Anticipos y notas crédito; se muestran, no se descartan"
        />
        <KpiCard label="Clases" value={miles(clases.length)} hint={`${miles(d?.terceros ?? 0)} terceros`} />
      </section>

      <section className="space-y-3">
        <SectionTitle>Composición por clase de documento</SectionTitle>
        <Card className="overflow-hidden">
          <BarrasDivergentes grupos={clases} onClick={(c) => abrirDrill(c)} seleccion={drill?.clase ?? null} />
        </Card>
      </section>

      <section className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <SectionTitle>Detalle por clase</SectionTitle>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs uppercase tracking-wider text-ink-muted">Ordenar</span>
            <FilterButton active={orden === 'saldo'} onClick={() => setOrden('saldo')}>
              Saldo
            </FilterButton>
            <FilterButton active={orden === 'nombre'} onClick={() => setOrden('nombre')}>
              Nombre
            </FilterButton>
            <FilterButton active={orden === 'terceros'} onClick={() => setOrden('terceros')}>
              Terceros
            </FilterButton>
          </div>
        </div>
        <Card className="overflow-hidden">
          {!clases.length ? (
            <EmptyState title={loading ? 'Cargando…' : 'Sin clases'} />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[720px] text-sm">
                <thead className="bg-surface-muted">
                  <tr>
                    <Th>Clase</Th>
                    <Th align="right">Saldo</Th>
                    <Th align="right">Por cobrar</Th>
                    <Th align="right">A favor</Th>
                    <Th align="center">Terceros</Th>
                    <Th align="center">Detalle</Th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {clases.map((c) => (
                    <tr key={c.codigo} className={`hover:bg-surface-hover ${drill?.clase === c.codigo ? 'bg-surface-hover' : ''}`}>
                      <td className="px-4 py-2.5">
                        <div className="text-ink">{c.nombre}</div>
                        <div className="tabular mt-0.5 font-mono text-[11px] text-ink-faint">{c.codigo}</div>
                      </td>
                      <td
                        className={`tabular whitespace-nowrap px-4 py-2.5 text-right font-medium ${
                          c.saldo < 0 ? 'text-danger' : 'text-ink'
                        }`}
                      >
                        {formatPrice(c.saldo)}
                      </td>
                      <td className="tabular whitespace-nowrap px-4 py-2.5 text-right text-ink-muted">
                        {formatPrice(c.saldoPositivo)}
                      </td>
                      <td className="tabular whitespace-nowrap px-4 py-2.5 text-right">
                        {c.saldoNegativo < 0 ? (
                          <span className="text-danger">{formatPrice(c.saldoNegativo)}</span>
                        ) : (
                          <span className="text-ink-faint">—</span>
                        )}
                      </td>
                      <td className="tabular px-4 py-2.5 text-center text-ink-muted">
                        {miles(c.terceros)}
                        {c.enNegativo > 0 && (
                          <span className="ml-1.5 align-middle">
                            <Badge tone="danger">{miles(c.enNegativo)} neg.</Badge>
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-2.5 text-center">
                        <button
                          onClick={() => abrirDrill(c.codigo)}
                          className="rounded border border-line px-2.5 py-1 text-xs text-ink-muted transition-colors hover:bg-surface hover:text-ink"
                        >
                          Ver terceros
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </section>

      {/* Drill: terceros de la clase seleccionada */}
      {drill && (
        <section className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <SectionTitle>Terceros de «{drill.nombreClase}»</SectionTitle>
            <button
              onClick={() => setDrill(null)}
              className="rounded border border-line px-3 py-1.5 text-sm text-ink-muted transition-colors hover:bg-surface-hover hover:text-ink"
            >
              Cerrar
            </button>
          </div>
          <Card className="overflow-hidden">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-3">
              <p className="text-xs text-ink-muted">
                {miles(drill.total)} terceros · página {drill.page} de {totalPaginasDrill}
                {drill.grupo ? ` · saldo de la clase ${formatPrice(drill.grupo.saldo)}` : ''}
                {cargandoDrill ? ' · actualizando…' : ''}
              </p>
              <div className="flex items-center gap-1.5">
                <button
                  onClick={() => abrirDrill(drill.clase, Math.max(1, drill.page - 1))}
                  disabled={drill.page <= 1 || cargandoDrill}
                  className="rounded border border-line px-2.5 py-1 text-sm text-ink-muted transition-colors hover:bg-surface-hover hover:text-ink disabled:opacity-40"
                >
                  ←
                </button>
                <button
                  onClick={() => abrirDrill(drill.clase, Math.min(totalPaginasDrill, drill.page + 1))}
                  disabled={drill.page >= totalPaginasDrill || cargandoDrill}
                  className="rounded border border-line px-2.5 py-1 text-sm text-ink-muted transition-colors hover:bg-surface-hover hover:text-ink disabled:opacity-40"
                >
                  →
                </button>
              </div>
            </div>
            {!drill.filas.length ? (
              <EmptyState title="Sin terceros en esta clase" />
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[640px] text-sm">
                  <thead className="bg-surface-muted">
                    <tr>
                      <Th>Tercero</Th>
                      <Th>Banco</Th>
                      <Th align="right">Saldo</Th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line">
                    {drill.filas.map((f) => (
                      <tr key={`${f.tercero}-${f.codigoBanco}`} className="hover:bg-surface-hover">
                        <td className="px-4 py-2.5">
                          <div className="max-w-[22rem] truncate text-ink" title={f.nombreTercero}>
                            {f.nombreTercero}
                          </div>
                          <div className="tabular mt-0.5 font-mono text-[11px] text-ink-faint">{f.tercero}</div>
                        </td>
                        <td className="px-4 py-2.5 text-xs text-ink-muted">{f.nombreBanco}</td>
                        <td
                          className={`tabular whitespace-nowrap px-4 py-2.5 text-right font-medium ${
                            f.saldo < 0 ? 'text-danger' : 'text-ink'
                          }`}
                        >
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

      {/* Concentración por banco: sólo si el ERP discrimina */}
      {d?.bancoDiscrimina && (d.porBanco?.length ?? 0) > 0 && (
        <section className="space-y-3">
          <SectionTitle>Concentración por banco</SectionTitle>
          <Card className="overflow-hidden">
            <BarrasDivergentes grupos={d.porBanco ?? []} />
          </Card>
        </section>
      )}
    </div>
  );
}
