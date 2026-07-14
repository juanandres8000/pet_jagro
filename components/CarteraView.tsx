'use client';

import { useState, useEffect } from 'react';
import type { CarteraResumen, BucketKey } from '@/lib/hgi/mappers/cartera';

interface CarteraViewProps {
  /** Navega a la vista de Clientes con el tercero prefiltrado. */
  onVerCliente?: (codigoTercero: string) => void;
}

const BUCKETS: Array<{ key: BucketKey; label: string; color: string }> = [
  { key: 'alDia', label: 'Al día', color: '#22C55E' },
  { key: '0-30', label: '0–30 d', color: '#7CB9E8' },
  { key: '31-60', label: '31–60 d', color: '#F59E0B' },
  { key: '61-90', label: '61–90 d', color: '#FB923C' },
  { key: '90+', label: '90+ d', color: '#EF4444' },
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

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl sm:text-3xl font-bold" style={{ color: '#1E293B', letterSpacing: '-0.5px' }}>
          Cartera
        </h1>
        {loading && <p className="text-sm mt-1" style={{ color: '#64748B' }}>Cargando cartera desde HGINet…</p>}
        {error && <p className="text-sm mt-1" style={{ color: '#EF4444' }}>No se pudo cargar: {error}</p>}
        {aviso && <p className="text-sm mt-1" style={{ color: '#F59E0B' }}>⚠ {aviso}</p>}
        {!loading && !error && resumen && (
          <p className="text-[10px] mt-1" style={{ color: '#94A3B8' }}>
            Cartera abierta ({resumen.docsAbiertos.toLocaleString('es-CO')} documentos · años {resumen.anios.join(', ')})
            {stale ? ' · datos en caché (reintentando)' : ''}
            {builtAt ? ` · actualizado ${new Date(builtAt).toLocaleString('es-CO')}` : ''}
          </p>
        )}
      </div>

      {resumen && (
        <>
          {/* KPI cards */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <Kpi label="Total abierto" value={fmtCOP(resumen.totalAbierto)} color="#1E293B" />
            <Kpi label="Total vencido" value={fmtCOP(resumen.totalVencido)} color="#EF4444" />
            <Kpi label="% en 90+ días" value={`${(resumen.pct90 * 100).toFixed(1)}%`} color="#EF4444" />
            <Kpi label="Terceros con saldo" value={resumen.terceros.toLocaleString('es-CO')} color="#5B9BD5" />
          </div>

          {/* Aging chart */}
          <div className="rounded-xl p-4 sm:p-6 shadow-sm" style={{ backgroundColor: '#FFFFFF', border: '1px solid #E2E8F0' }}>
            <h2 className="text-sm font-semibold mb-4" style={{ color: '#1E293B' }}>Aging por antigüedad</h2>
            <div className="space-y-2">
              {BUCKETS.map((b) => {
                const bucket = resumen.buckets[b.key] ?? { docs: 0, saldo: 0 };
                const pct = (bucket.saldo / maxBucketSaldo) * 100;
                const pctTotal = resumen.totalAbierto > 0 ? (bucket.saldo / resumen.totalAbierto) * 100 : 0;
                return (
                  <div key={b.key} className="flex items-center gap-3">
                    <div className="w-16 text-xs text-right shrink-0" style={{ color: '#64748B' }}>{b.label}</div>
                    <div className="flex-1 h-6 rounded overflow-hidden" style={{ backgroundColor: '#F1F5F9' }}>
                      <div
                        className="h-full rounded transition-all"
                        style={{ width: `${Math.max(pct, bucket.saldo > 0 ? 2 : 0)}%`, backgroundColor: b.color }}
                      />
                    </div>
                    <div className="w-40 text-xs text-right shrink-0" style={{ color: '#1E293B' }}>
                      {fmtCOP(bucket.saldo)}
                      <span className="ml-1" style={{ color: '#94A3B8' }}>
                        ({pctTotal.toFixed(0)}% · {bucket.docs})
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Top deudores */}
          <div className="rounded-xl p-3 sm:p-6 shadow-sm" style={{ backgroundColor: '#FFFFFF', border: '1px solid #E2E8F0' }}>
            <h2 className="text-sm font-semibold mb-3" style={{ color: '#1E293B' }}>Top 10 deudores</h2>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[560px]">
                <thead style={{ backgroundColor: '#F8FAFC' }}>
                  <tr>
                    {['Tercero', 'Saldo total', 'Saldo vencido', 'Días máx mora', ''].map((h) => (
                      <th key={h} className="text-left px-3 py-2 text-xs font-semibold" style={{ color: '#64748B' }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {resumen.topDeudores.map((d, i) => (
                    <tr key={d.codigoTercero} style={{ borderTop: '1px solid #E2E8F0' }}>
                      <td className="px-3 py-2 text-sm font-medium" style={{ color: '#1E293B' }}>
                        <span className="mr-2" style={{ color: '#94A3B8' }}>{i + 1}.</span>
                        {d.nombre}
                        <span className="block text-[10px] font-mono" style={{ color: '#94A3B8' }}>{d.codigoTercero}</span>
                      </td>
                      <td className="px-3 py-2 text-sm text-right" style={{ color: '#1E293B' }}>{fmtCOP(d.saldoTotal)}</td>
                      <td className="px-3 py-2 text-sm text-right font-medium" style={{ color: d.saldoVencido > 0 ? '#EF4444' : '#64748B' }}>
                        {d.saldoVencido > 0 ? fmtCOP(d.saldoVencido) : '—'}
                      </td>
                      <td className="px-3 py-2 text-sm text-center">
                        <span
                          className="px-2 py-0.5 rounded-full text-xs font-semibold"
                          style={{
                            backgroundColor: d.diasMaxMora > 90 ? '#FEE2E2' : d.diasMaxMora > 0 ? '#FEF3C7' : '#DCFCE7',
                            color: d.diasMaxMora > 90 ? '#991B1B' : d.diasMaxMora > 0 ? '#92400E' : '#166534',
                          }}
                        >
                          {d.diasMaxMora > 0 ? `${d.diasMaxMora} d` : 'al día'}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-xs text-right">
                        {onVerCliente && (
                          <button
                            type="button"
                            onClick={() => onVerCliente(d.codigoTercero)}
                            className="font-medium underline"
                            style={{ color: '#5B9BD5' }}
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
          </div>
        </>
      )}
    </div>
  );
}

function Kpi({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div className="rounded-xl p-4 shadow-sm" style={{ backgroundColor: '#FFFFFF', border: '1px solid #E2E8F0' }}>
      <div className="text-xs uppercase tracking-wide" style={{ color: '#64748B' }}>{label}</div>
      <div className="text-xl sm:text-2xl font-bold mt-1" style={{ color }}>{value}</div>
    </div>
  );
}
