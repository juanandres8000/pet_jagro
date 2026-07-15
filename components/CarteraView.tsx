'use client';

import { useState, useEffect } from 'react';
import type { CarteraResumen, BucketKey } from '@/lib/hgi/mappers/cartera';
import { PageHeader, KpiCard, Card, Badge, Th, Tone } from '@/components/ui';

interface CarteraViewProps {
  /** Navega a la vista de Clientes con el tercero prefiltrado. */
  onVerCliente?: (codigoTercero: string) => void;
}

// Clases literales: Tailwind purga las construidas por interpolación.
const BUCKETS: Array<{ key: BucketKey; label: string; bar: string }> = [
  { key: 'alDia', label: 'Al día', bar: 'bg-accent' },
  { key: '0-30', label: '0–30 d', bar: 'bg-accent-light' },
  { key: '31-60', label: '31–60 d', bar: 'bg-warn/60' },
  { key: '61-90', label: '61–90 d', bar: 'bg-warn' },
  { key: '90+', label: '90+ d', bar: 'bg-danger' },
];

const fmtCOP = (v: number) =>
  new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 }).format(v);

export default function CarteraView({ onVerCliente }: CarteraViewProps) {
  const [resumen, setResumen] = useState<CarteraResumen | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const [builtAt, setBuiltAt] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/cartera');
        const data = await res.json();
        if (cancelled) return;
        if (!res.ok || !data.ok) {
          setError(data?.mensaje || `Error ${res.status}`);
        } else {
          setResumen(data.resumen ?? null);
          setAviso(data.aviso ?? null);
          setStale(!!data.stale);
          setBuiltAt(data.built_at ?? null);
        }
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

  const maxBucketSaldo = resumen
    ? Math.max(1, ...BUCKETS.map((b) => resumen.buckets[b.key]?.saldo ?? 0))
    : 1;

  // Mismos umbrales de mora de siempre; sólo cambia la paleta.
  const moraTone = (diasMaxMora: number): Tone =>
    diasMaxMora > 90 ? 'danger' : diasMaxMora > 0 ? 'warn' : 'accent';

  const subtitle = (
    <>
      {loading && <span className="block">Cargando cartera desde HGINet…</span>}
      {error && <span className="block text-danger">No se pudo cargar: {error}</span>}
      {aviso && <span className="block text-warn">⚠ {aviso}</span>}
      {!loading && !error && resumen && (
        <span className="tabular block text-xs text-ink-faint">
          Cartera abierta ({resumen.docsAbiertos.toLocaleString('es-CO')} documentos · años {resumen.anios.join(', ')})
          {stale ? ' · datos en caché (reintentando)' : ''}
          {builtAt ? ` · actualizado ${new Date(builtAt).toLocaleString('es-CO')}` : ''}
        </span>
      )}
    </>
  );

  return (
    <div className="space-y-8">
      <PageHeader title="Cartera" subtitle={subtitle} />

      {resumen && (
        <>
          {/* KPI cards */}
          <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-4">
            <KpiCard label="Total abierto" value={fmtCOP(resumen.totalAbierto)} />
            <KpiCard label="Total vencido" value={fmtCOP(resumen.totalVencido)} tone="danger" />
            <KpiCard label="% en 90+ días" value={`${(resumen.pct90 * 100).toFixed(1)}%`} tone="danger" />
            <KpiCard label="Terceros con saldo" value={resumen.terceros.toLocaleString('es-CO')} tone="accent" />
          </div>

          {/* Aging chart */}
          <Card className="p-6">
            <h2 className="font-serif text-xl font-semibold tracking-tight text-ink">Aging por antigüedad</h2>
            <div className="mt-5 space-y-3">
              {BUCKETS.map((b) => {
                const bucket = resumen.buckets[b.key] ?? { docs: 0, saldo: 0 };
                const pct = (bucket.saldo / maxBucketSaldo) * 100;
                const pctTotal = resumen.totalAbierto > 0 ? (bucket.saldo / resumen.totalAbierto) * 100 : 0;
                return (
                  <div key={b.key} className="flex items-center gap-3">
                    <div className="w-16 shrink-0 text-right text-xs font-medium text-ink-muted">{b.label}</div>
                    <div className="h-6 flex-1 overflow-hidden rounded bg-cream-deep">
                      <div
                        className={`h-full rounded transition-all ${b.bar}`}
                        style={{ width: `${Math.max(pct, bucket.saldo > 0 ? 2 : 0)}%` }}
                      />
                    </div>
                    <div className="tabular w-40 shrink-0 text-right text-xs text-ink">
                      {fmtCOP(bucket.saldo)}
                      <span className="ml-1 text-ink-faint">
                        ({pctTotal.toFixed(0)}% · {bucket.docs})
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          </Card>

          {/* Top deudores */}
          <Card>
            <div className="border-b border-line p-6">
              <h2 className="font-serif text-xl font-semibold tracking-tight text-ink">Top 10 deudores</h2>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[640px]">
                <thead className="bg-surface-muted">
                  <tr className="border-b border-line">
                    <Th>Tercero</Th>
                    <Th align="right">Saldo total</Th>
                    <Th align="right">Saldo vencido</Th>
                    <Th align="center">Días máx mora</Th>
                    <Th align="right" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {resumen.topDeudores.map((d, i) => (
                    <tr key={d.codigoTercero} className="transition-colors hover:bg-surface-muted">
                      <td className="px-4 py-3">
                        <div className="text-sm font-medium text-ink">
                          <span className="tabular mr-2 text-ink-faint">{i + 1}.</span>
                          {d.nombre}
                        </div>
                        <div className="tabular mt-0.5 font-mono text-xs text-ink-faint">{d.codigoTercero}</div>
                      </td>
                      <td className="tabular px-4 py-3 text-right text-sm text-ink">{fmtCOP(d.saldoTotal)}</td>
                      <td
                        className={`tabular px-4 py-3 text-right text-sm font-semibold ${
                          d.saldoVencido > 0 ? 'text-danger' : 'text-ink-muted'
                        }`}
                      >
                        {d.saldoVencido > 0 ? fmtCOP(d.saldoVencido) : '—'}
                      </td>
                      <td className="px-4 py-3 text-center">
                        <Badge tone={moraTone(d.diasMaxMora)}>
                          <span className="tabular">{d.diasMaxMora > 0 ? `${d.diasMaxMora} d` : 'al día'}</span>
                        </Badge>
                      </td>
                      <td className="px-4 py-3 text-right">
                        {onVerCliente && (
                          <button
                            type="button"
                            onClick={() => onVerCliente(d.codigoTercero)}
                            className="text-sm font-medium text-accent transition-colors hover:text-accent-dark hover:underline"
                          >
                            Ver cliente →
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        </>
      )}
    </div>
  );
}
