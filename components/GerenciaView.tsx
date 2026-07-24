'use client';

import { useEffect, useState } from 'react';
import type { VentasResumen, VentaPorClave } from '@/lib/hgi/mappers/ventas';
import type { RecaudoResumen } from '@/lib/hgi/mappers/recaudo';
import type { CarteraResumen } from '@/lib/hgi/mappers/cartera';
import { PageHeader, SectionTitle, KpiCard, Card, Th, EmptyState, Tone } from '@/components/ui';
import { formatPrice, kpiMoney } from '@/lib/format';

/**
 * Vista Gerencia: la home del dashboard.
 * Lee de los tres snapshots ya agregados (/api/ventas, /api/recaudo,
 * /api/cartera) — no hace cálculos de negocio, sólo presenta. Las reglas de
 * margen viven en lib/hgi/mappers/ventas.ts.
 */

const pctFmt = (v: number) => `${(v * 100).toFixed(1)}%`;

/** Variación mes vs mes: signo explícito, o guion si no hay base comparable. */
function delta(v: number | null | undefined, sufijo = ''): { texto: string; tone: Tone } {
  if (v === null || v === undefined || !Number.isFinite(v)) {
    return { texto: 'sin mes anterior comparable', tone: 'neutral' };
  }
  const pct = (v * 100).toFixed(1);
  const signo = v > 0 ? '+' : '';
  return { texto: `${signo}${pct}${sufijo} vs mes anterior`, tone: v >= 0 ? 'accent' : 'danger' };
}

/** Fecha YYYY-MM-DD → "23 jul" sin depender de la zona del navegador. */
const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
const diaCorto = (iso: string) => {
  const [, m, d] = iso.split('-');
  return `${Number(d)} ${MESES[Number(m) - 1] ?? ''}`;
};

/** Barra apilada costo + margen = venta. Un solo acento, margen en tono claro. */
function GraficoDiario({ dias }: { dias: VentasResumen['porDia'] }) {
  if (!dias.length) return <EmptyState title="Sin ventas en el periodo" />;
  const max = Math.max(1, ...dias.map((d) => Math.abs(d.venta)));

  return (
    <div className="overflow-x-auto">
      <div className="flex min-w-full items-end gap-1 px-4 pb-2 pt-6" style={{ height: 220 }}>
        {dias.map((d) => {
          const hVenta = (Math.abs(d.venta) / max) * 170;
          const hCosto = (Math.abs(d.costo) / max) * 170;
          return (
            <div key={d.fecha} className="group flex flex-1 flex-col items-center justify-end" style={{ minWidth: 18 }}>
              <div
                className="relative flex w-full max-w-[26px] flex-col justify-end rounded-t"
                style={{ height: hVenta }}
                title={`${diaCorto(d.fecha)} · venta ${formatPrice(d.venta)} · costo ${formatPrice(d.costo)} · margen ${formatPrice(d.margen)} · ${d.documentos} doc.`}
              >
                <div className="w-full rounded-t bg-accent-light" style={{ height: Math.max(0, hVenta - hCosto) }} />
                <div className="w-full bg-accent" style={{ height: hCosto }} />
              </div>
              <div className="mt-1.5 tabular text-[10px] text-ink-faint">{d.fecha.slice(8)}</div>
            </div>
          );
        })}
      </div>
      <div className="flex items-center gap-4 border-t border-line px-4 py-2 text-xs text-ink-muted">
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-2.5 rounded-sm bg-accent" /> Costo
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-2.5 rounded-sm bg-accent-light" /> Margen
        </span>
        <span className="text-ink-faint">La altura total es la venta del día</span>
      </div>
    </div>
  );
}

/** Ranking con barra de proporción sobre la venta. */
function Ranking({
  filas,
  etiqueta,
  vacio,
}: {
  filas: VentaPorClave[];
  etiqueta: string;
  vacio: string;
}) {
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
  );
}

interface Estado {
  ventas: VentasResumen | null;
  recaudo: RecaudoResumen | null;
  cartera: CarteraResumen | null;
  avisos: string[];
  builtAt: { ventas?: string; recaudo?: string; cartera?: string };
}

export default function GerenciaView() {
  const [d, setD] = useState<Estado>({ ventas: null, recaudo: null, cartera: null, avisos: [], builtAt: {} });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [v, r, c] = await Promise.all([
          fetch('/api/ventas').then((x) => x.json()),
          fetch('/api/recaudo').then((x) => x.json()),
          fetch('/api/cartera').then((x) => x.json()),
        ]);
        if (cancelled) return;
        setD({
          ventas: v?.resumen ?? null,
          recaudo: r?.resumen ?? null,
          cartera: c?.resumen ?? null,
          avisos: [v?.aviso, r?.aviso, c?.aviso].filter(Boolean) as string[],
          builtAt: { ventas: v?.built_at, recaudo: r?.built_at, cartera: c?.built_at },
        });
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const v = d.ventas;
  const dVenta = delta(v?.variacion.venta);
  const dMargenPts = v?.variacion.margenPctPuntos;
  const pct90 = d.cartera ? d.cartera.pct90 : null;

  const subtitle = (
    <>
      {loading && <span className="block">Cargando indicadores…</span>}
      {error && <span className="block text-danger">No se pudo cargar: {error}</span>}
      {d.avisos.map((a) => (
        <span key={a} className="block text-warn">
          ⚠ {a}
        </span>
      ))}
      {!loading && !error && v && (
        <span className="tabular block text-xs text-ink-faint">
          Periodo {v.periodo.desde} → {v.periodo.hasta} · {v.mesActual.documentos.toLocaleString('es-CO')} facturas ·{' '}
          {v.mesActual.lineas.toLocaleString('es-CO')} líneas
          {d.builtAt.ventas ? ` · actualizado ${new Date(d.builtAt.ventas).toLocaleString('es-CO')}` : ''}
        </span>
      )}
    </>
  );

  return (
    <div className="space-y-8">
      <PageHeader title="Gerencia" subtitle={subtitle} />

      <section className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <KpiCard
          label="Venta neta del mes"
          {...kpiMoney(v?.mesActual.venta ?? 0)}
          delta={dVenta.texto}
          tone={dVenta.tone}
        />
        <KpiCard
          label="Margen"
          value={v ? pctFmt(v.mesActual.margenPct) : '—'}
          tone={(v?.mesActual.margen ?? 0) >= 0 ? 'accent' : 'danger'}
          delta={
            dMargenPts === null || dMargenPts === undefined
              ? 'sin mes anterior comparable'
              : `${dMargenPts >= 0 ? '+' : ''}${(dMargenPts * 100).toFixed(1)} pp vs mes anterior`
          }
          hint={v ? `${formatPrice(v.mesActual.margen)} sobre ${formatPrice(v.mesActual.costo)} de costo` : undefined}
        />
        <KpiCard
          label="Recaudo del mes"
          {...kpiMoney(d.recaudo?.totalRecaudo ?? 0)}
          tone="accent"
          hint={
            d.recaudo
              ? `${d.recaudo.operaciones.toLocaleString('es-CO')} pagos · ${pctFmt(d.recaudo.pctAlDia)} al día`
              : undefined
          }
        />
        <KpiCard
          label="Cartera abierta"
          {...kpiMoney(d.cartera?.totalAbierto ?? 0)}
          tone={pct90 !== null && pct90 > 0.2 ? 'danger' : pct90 !== null && pct90 > 0.1 ? 'warn' : 'neutral'}
          delta={pct90 !== null ? `${pctFmt(pct90)} con más de 90 días` : undefined}
          hint={d.cartera ? `${d.cartera.terceros.toLocaleString('es-CO')} terceros` : undefined}
        />
      </section>

      <section className="space-y-3">
        <SectionTitle>Venta y costo por día</SectionTitle>
        <Card>{v ? <GraficoDiario dias={v.porDia} /> : <EmptyState title="Sin datos de ventas" />}</Card>
      </section>

      <div className="grid grid-cols-1 gap-8 xl:grid-cols-2">
        <section className="space-y-3">
          <SectionTitle>Margen por línea de producto</SectionTitle>
          <Card className="overflow-hidden">
            <Ranking
              filas={v?.porLinea ?? []}
              etiqueta="Línea"
              vacio="Sin líneas en el periodo"
            />
          </Card>
        </section>

        <section className="space-y-3">
          <SectionTitle>Vendedores</SectionTitle>
          <Card className="overflow-hidden">
            <Ranking filas={v?.porVendedor ?? []} etiqueta="Vendedor" vacio="Sin vendedores en el periodo" />
          </Card>
        </section>
      </div>

      <section className="space-y-3">
        <SectionTitle>Top 10 clientes del mes</SectionTitle>
        <Card className="overflow-hidden">
          <Ranking filas={v?.topClientes ?? []} etiqueta="Cliente" vacio="Sin clientes en el periodo" />
        </Card>
      </section>

      <section className="space-y-3">
        <SectionTitle>Top 10 productos del mes</SectionTitle>
        <Card className="overflow-hidden">
          <Ranking filas={v?.topProductos ?? []} etiqueta="Producto" vacio="Sin productos en el periodo" />
        </Card>
      </section>

      {d.recaudo && d.recaudo.totalAjustes !== 0 && (
        <p className="text-xs text-ink-faint">
          Recaudo excluye {formatPrice(d.recaudo.totalAjustes)} en descuentos y notas aplicados contra cartera: se
          descargan del saldo pero no son caja.
        </p>
      )}
    </div>
  );
}
