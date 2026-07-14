'use client';

import { useState, useEffect, useMemo } from 'react';
import type { Cliente } from '@/lib/hgi/mappers/terceros';
import type { CarteraCliente } from '@/lib/hgi/mappers/cartera';

const MAX_ROWS = 300;

// Toggle de subtipo de cliente. Los datos ya llegan filtrados a 1+7 desde el backend.
type ClienteFiltro = 'ambos' | '1' | '7';

interface TipoInfo {
  descripcion: string;
  count: number;
}

interface ClientesViewProps {
  /** Búsqueda inicial (p.ej. al navegar desde Cartera con un CodigoTercero). */
  initialSearch?: string;
}

export default function ClientesView({ initialSearch = '' }: ClientesViewProps) {
  const [clientes, setClientes] = useState<Cliente[]>([]);
  const [tipos, setTipos] = useState<Record<string, TipoInfo>>({});
  const [carteraById, setCarteraById] = useState<Map<string, CarteraCliente>>(new Map());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const [stale, setStale] = useState(false);

  const [search, setSearch] = useState(initialSearch);
  const [tipoFilter, setTipoFilter] = useState<ClienteFiltro>('ambos');

  // Sincroniza la búsqueda cuando llega un nuevo initialSearch (link de Cartera).
  useEffect(() => {
    if (initialSearch) setSearch(initialSearch);
  }, [initialSearch]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // Clientes (fuente) + cartera (best-effort para el saldo) en paralelo.
        const [res, carRes] = await Promise.all([fetch('/api/clientes'), fetch('/api/cartera')]);
        const data = await res.json();
        if (cancelled) return;
        if (!res.ok || !data.ok) {
          setError(data?.mensaje || `Error ${res.status}`);
        } else {
          setClientes(Array.isArray(data.clientes) ? data.clientes : []);
          setTipos(data.tiposCliente ?? {});
          setAviso(data.aviso ?? null);
          setStale(!!data.stale);
        }
        try {
          const car = await carRes.json();
          if (!cancelled && car?.ok && Array.isArray(car.clientes)) {
            setCarteraById(new Map((car.clientes as CarteraCliente[]).map((c) => [c.codigoTercero, c])));
          }
        } catch {
          /* cartera es opcional; sin ella no se muestra saldo */
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

  const formatCupo = (v: number) =>
    new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', minimumFractionDigits: 0 }).format(v);

  const filtered = useMemo(() => {
    let result = clientes;
    if (tipoFilter !== 'ambos') {
      result = result.filter((c) => c.codigoTipoTercero === tipoFilter);
    }
    const q = search.trim().toLowerCase();
    if (q) {
      result = result.filter(
        (c) =>
          c.nombre.toLowerCase().includes(q) ||
          c.id.toLowerCase().includes(q) ||
          (c.email?.toLowerCase().includes(q) ?? false),
      );
    }
    return result;
  }, [clientes, tipoFilter, search]);

  // Etiquetas del toggle con conteo (de tiposCliente, ya restringido a 1 y 7).
  const toggleOpts: Array<{ key: ClienteFiltro; label: string }> = [
    { key: 'ambos', label: `Ambos (${clientes.length})` },
    { key: '1', label: `Generales (${tipos['1']?.count ?? 0})` },
    { key: '7', label: `Mostrador (${tipos['7']?.count ?? 0})` },
  ];

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl sm:text-3xl font-bold" style={{ color: '#1E293B', letterSpacing: '-0.5px' }}>
          Clientes
        </h1>
        {loading && <p className="text-sm mt-1" style={{ color: '#64748B' }}>Cargando terceros desde HGINet…</p>}
        {error && <p className="text-sm mt-1" style={{ color: '#EF4444' }}>No se pudieron cargar: {error}</p>}
        {aviso && <p className="text-sm mt-1" style={{ color: '#F59E0B' }}>⚠ {aviso}</p>}
        {!loading && !error && !aviso && (
          <p className="text-[10px] mt-1" style={{ color: '#94A3B8' }}>
            Terceros en vivo desde HGINet{stale ? ' · datos en caché (reintentando actualización)' : ''}
          </p>
        )}
      </div>

      <div className="rounded-xl p-3 sm:p-6 shadow-sm" style={{ backgroundColor: '#FFFFFF', border: '1px solid #E2E8F0' }}>
        {/* Controles */}
        <div className="flex flex-col sm:flex-row gap-3 mb-4">
          <input
            type="text"
            placeholder="Buscar por nombre, identificación o email…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="flex-1 px-3 py-2 rounded-lg text-sm outline-none"
            style={{ border: '1px solid #E2E8F0', color: '#1E293B' }}
          />
          <div className="flex rounded-lg overflow-hidden" style={{ border: '1px solid #E2E8F0' }}>
            {toggleOpts.map((opt) => {
              const active = tipoFilter === opt.key;
              return (
                <button
                  key={opt.key}
                  type="button"
                  onClick={() => setTipoFilter(opt.key)}
                  className="px-3 py-2 text-sm font-medium whitespace-nowrap"
                  style={{
                    backgroundColor: active ? '#7CB9E8' : '#FFFFFF',
                    color: active ? '#FFFFFF' : '#64748B',
                  }}
                >
                  {opt.label}
                </button>
              );
            })}
          </div>
        </div>

        <p className="text-xs mb-3" style={{ color: '#64748B' }}>
          Mostrando {Math.min(filtered.length, MAX_ROWS)} de {filtered.length}
          {filtered.length > MAX_ROWS ? ' (primeros ' + MAX_ROWS + ', refina la búsqueda)' : ''}
        </p>

        {/* Tabla */}
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px]">
            <thead style={{ backgroundColor: '#F8FAFC' }}>
              <tr>
                {['Nombre', 'Identificación', 'Tipo', 'Ciudad', 'Teléfono', 'Email', 'Cupo', 'Plazo', 'Estado'].map((h) => (
                  <th key={h} className="text-left px-3 py-2 text-xs font-semibold" style={{ color: '#64748B' }}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 ? (
                <tr>
                  <td colSpan={9} className="px-3 py-8 text-center text-sm" style={{ color: '#94A3B8' }}>
                    {loading ? 'Cargando…' : 'Sin resultados'}
                  </td>
                </tr>
              ) : (
                filtered.slice(0, MAX_ROWS).map((c) => (
                  <tr key={c.id} style={{ borderTop: '1px solid #E2E8F0' }}>
                    <td className="px-3 py-2 text-sm font-medium" style={{ color: '#1E293B' }}>
                      <span className="inline-flex items-center gap-1.5 flex-wrap">
                        {c.nombre}
                        {c.alertaCartera && (
                          <span
                            className="px-2 py-0.5 rounded-full text-[10px] font-semibold whitespace-nowrap"
                            style={{ backgroundColor: '#FEE2E2', color: '#991B1B' }}
                            title={c.motivoAlerta ?? 'Alerta de cartera'}
                          >
                            ⚠ Cartera
                          </span>
                        )}
                        {(() => {
                          const car = carteraById.get(c.id);
                          return car && car.saldoVencido > 0 ? (
                            <span
                              className="px-2 py-0.5 rounded-full text-[10px] font-semibold whitespace-nowrap"
                              style={{ backgroundColor: '#FEF3C7', color: '#92400E' }}
                              title={`Saldo vencido · días máx mora: ${car.diasMaxMora}`}
                            >
                              {formatCupo(car.saldoVencido)} vencido
                            </span>
                          ) : null;
                        })()}
                      </span>
                      {c.nombreComercial ? <span className="block text-[10px]" style={{ color: '#94A3B8' }}>{c.nombreComercial}</span> : null}
                    </td>
                    <td className="px-3 py-2 text-xs font-mono" style={{ color: '#64748B' }}>
                      {c.identificacion}
                      <span className="block text-[10px]">{c.tipoIdentificacion} · {c.tipoPersona === 'juridica' ? 'Jurídica' : 'Natural'}</span>
                    </td>
                    <td className="px-3 py-2 text-xs" style={{ color: '#64748B' }}>
                      {c.tipoTerceroDescripcion ?? c.codigoTipoTercero}
                    </td>
                    <td className="px-3 py-2 text-sm" style={{ color: '#1E293B' }}>{c.ciudad ?? '—'}</td>
                    <td className="px-3 py-2 text-sm" style={{ color: '#1E293B' }}>{c.telefono ?? '—'}</td>
                    <td className="px-3 py-2 text-xs" style={{ color: '#1E293B' }}>{c.email ?? '—'}</td>
                    <td className="px-3 py-2 text-sm text-right" style={{ color: '#1E293B' }}>{c.cupo > 0 ? formatCupo(c.cupo) : '—'}</td>
                    <td className="px-3 py-2 text-sm text-center" style={{ color: '#1E293B' }}>{c.plazo > 0 ? `${c.plazo}d` : '—'}</td>
                    <td className="px-3 py-2 text-xs">
                      <span
                        className="px-2 py-0.5 rounded-full font-medium"
                        style={{
                          backgroundColor: c.activo ? '#DCFCE7' : '#FEE2E2',
                          color: c.activo ? '#166534' : '#991B1B',
                        }}
                      >
                        {c.activo ? 'Activo' : 'Inactivo'}
                      </span>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
