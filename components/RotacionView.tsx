'use client';

import { useEffect, useMemo, useState } from 'react';
import { PageHeader, SectionTitle, KpiCard, Card, Th, EmptyState, FilterButton, Badge, type Tone } from '@/components/ui';
import { formatPrice, kpiMoney } from '@/lib/format';

/**
 * Rotación de inventario (docs/ROTACION.md): inicial, entradas, salidas, final y
 * días en inventario por producto y proveedor, más existencia actual, cobertura y
 * sugerido de compra. Todo el cálculo llega resuelto de /api/rotacion.
 */

type Estado = 'agotado' | 'por_agotarse' | 'normal' | 'sobrestock' | 'sin_movimiento' | 'sin_existencia';

interface Producto {
  codigo: string;
  nombre: string;
  nitProveedor: string;
  nombreProveedor: string;
  inicial: number;
  entradas: number;
  compras: number;
  salidas: number;
  ventasNetas: number;
  final: number;
  diasInventario: number | null;
  rotacion: number | null;
  existencia: number;
  costoUnitario: number;
  valorExistencia: number;
  ventaDiaria: number;
  cobertura: number | null;
  sugerido: number;
  estado: Estado;
}

interface Proveedor {
  nit: string;
  nombre: string;
  productos: number;
  valorExistencia: number;
  diasInventario: number | null;
  agotados: number;
  porAgotarse: number;
  sinMovimiento: number;
  valorSinMovimiento: number;
  valorSugerido: number;
}

interface Resp {
  ok: boolean;
  mensaje?: string;
  completo: boolean;
  mesesSinDatos: string[];
  mesesDisponibles: string[];
  desde: string;
  hasta: string;
  bodega: string;
  diasObjetivo: number;
  dias: number;
  incluyeMesAbierto: boolean;
  existenciasTomadasEn: string | null;
  kpis: {
    productos: number;
    valorExistencia: number;
    diasInventario: number | null;
    agotados: number;
    porAgotarse: number;
    sinMovimiento: number;
    valorSinMovimiento: number;
    sobrestock: number;
    valorSugerido: number;
  } | null;
  proveedores: Proveedor[];
  productos: Producto[];
}

const ESTADO: Record<Estado, { texto: string; tone: Tone }> = {
  agotado: { texto: 'Agotado', tone: 'danger' },
  por_agotarse: { texto: 'Por agotarse', tone: 'warn' },
  normal: { texto: 'Normal', tone: 'accent' },
  sobrestock: { texto: 'Sobrestock', tone: 'warn' },
  sin_movimiento: { texto: 'Sin movimiento', tone: 'neutral' },
  sin_existencia: { texto: 'Sin existencia', tone: 'neutral' },
};

const BODEGAS = [
  { id: '01', texto: 'Bodega 01 · Medellín' },
  { id: '02', texto: 'Bodega 02 · Oriente' },
  { id: '03', texto: 'Bodega 03 · Insumos' },
  { id: 'todas', texto: 'Todas las bodegas' },
];
const DIAS = [15, 30, 45, 60, 90];

const MESES_CORTO = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
const mesCorto = (mes: string) => `${MESES_CORTO[Number(mes.slice(5, 7)) - 1] ?? mes} ${mes.slice(0, 4)}`;
const miles = (n: number) => n.toLocaleString('es-CO', { maximumFractionDigits: 0 });
const dec = (n: number | null, d = 1) => (n === null ? '—' : n.toLocaleString('es-CO', { maximumFractionDigits: d }));
const sumarMeses = (mes: string, k: number) => {
  const [y, m] = mes.split('-').map(Number);
  const t = y * 12 + (m - 1) + k;
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}`;
};
const mesActual = () => {
  const d = new Date(Date.now() - 5 * 3_600_000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
};

type Preset = 'mes' | 'trimestre' | 'semestre' | 'rango';
function rangoDe(p: Preset): { desde: string; hasta: string } {
  const hasta = sumarMeses(mesActual(), -1); // último mes cerrado
  if (p === 'mes') return { desde: hasta, hasta };
  if (p === 'semestre') return { desde: sumarMeses(hasta, -5), hasta };
  return { desde: sumarMeses(hasta, -2), hasta };
}

type Orden = 'proveedor' | 'sugerido' | 'cobertura' | 'dias' | 'valor';
const ORDEN: Record<Orden, string> = {
  proveedor: 'Proveedor y nombre',
  sugerido: 'Mayor sugerido de compra',
  cobertura: 'Menor cobertura',
  dias: 'Más días en inventario',
  valor: 'Mayor valor en existencia',
};

const SELECT = 'rounded border border-line bg-surface px-2 py-1.5 text-sm text-ink';
const SOLO_MD = 'hidden md:table-cell';
const SOLO_LG = 'hidden lg:table-cell';
const PAGINA = 150;

export default function RotacionView() {
  const [preset, setPreset] = useState<Preset>('trimestre');
  const [rango, setRango] = useState(rangoDe('trimestre'));
  const [bodega, setBodega] = useState('01');
  const [dias, setDias] = useState(30);
  const [data, setData] = useState<Resp | null>(null);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [proveedor, setProveedor] = useState<string | null>(null);
  const [busqueda, setBusqueda] = useState('');
  const [estado, setEstado] = useState<Estado | 'todos' | 'alerta'>('todos');
  const [orden, setOrden] = useState<Orden>('proveedor');
  const [limite, setLimite] = useState(PAGINA);

  useEffect(() => {
    let vigente = true;
    setCargando(true);
    const url = `/api/rotacion?desde=${rango.desde}&hasta=${rango.hasta}&bodega=${bodega}&dias=${dias}`;
    fetch(url)
      .then((r) => r.json())
      .catch(() => null)
      .then((j: Resp | null) => {
        if (!vigente) return;
        if (!j) setError('No se pudo contactar al servidor');
        else if (!j.ok) setError(j.mensaje ?? 'Error desconocido');
        else {
          setError(null);
          setData(j);
        }
        setCargando(false);
      });
    return () => {
      vigente = false;
    };
  }, [rango, bodega, dias]);

  useEffect(() => setLimite(PAGINA), [proveedor, busqueda, estado, orden, data]);

  const elegirPreset = (p: Preset) => {
    setPreset(p);
    if (p !== 'rango') setRango(rangoDe(p));
  };

  const productos = useMemo(() => {
    const q = busqueda.trim().toLowerCase();
    const out = (data?.productos ?? []).filter(
      (p) =>
        (proveedor === null || p.nitProveedor === proveedor) &&
        (estado === 'todos' || (estado === 'alerta' ? p.estado === 'agotado' || p.estado === 'por_agotarse' : p.estado === estado)) &&
        (!q || p.nombre.toLowerCase().includes(q) || p.codigo.includes(q)),
    );
    const cmp: Record<Orden, (a: Producto, b: Producto) => number> = {
      proveedor: () => 0,
      sugerido: (a, b) => b.sugerido * b.costoUnitario - a.sugerido * a.costoUnitario,
      cobertura: (a, b) => (a.cobertura ?? Infinity) - (b.cobertura ?? Infinity),
      dias: (a, b) => (b.diasInventario ?? -1) - (a.diasInventario ?? -1),
      valor: (a, b) => b.valorExistencia - a.valorExistencia,
    };
    return orden === 'proveedor' ? out : [...out].sort(cmp[orden]);
  }, [data, proveedor, busqueda, estado, orden]);

  const k = data?.kpis;
  const nombreProv = proveedor === null ? null : (data?.proveedores.find((p) => p.nit === proveedor)?.nombre ?? 'Sin proveedor');
  const mesesOpc = useMemo(() => {
    const out: string[] = [];
    for (let m = '2026-01'; m <= mesActual(); m = sumarMeses(m, 1)) out.push(m);
    return out;
  }, []);
  const reporte =
    data?.completo &&
    `/api/rotacion/reporte?desde=${data.desde}&hasta=${data.hasta}&bodega=${data.bodega}&dias=${data.diasObjetivo}${proveedor !== null ? `&proveedor=${encodeURIComponent(proveedor)}` : ''}`;

  const subtitle = (
    <>
      {cargando && <span className="block">Cargando rotación…</span>}
      {error && <span className="block text-danger">No se pudo cargar: {error}</span>}
      {data?.completo && (
        <span className="tabular block text-xs text-ink-faint">
          {data.desde === data.hasta ? mesCorto(data.desde) : `${mesCorto(data.desde)} a ${mesCorto(data.hasta)}`} · {data.dias} días ·
          unidades · {BODEGAS.find((b) => b.id === data.bodega)?.texto}
          {data.existenciasTomadasEn &&
            ` · existencia actual de HGI al ${new Date(data.existenciasTomadasEn).toLocaleString('es-CO', { dateStyle: 'medium', timeStyle: 'short' })}`}
        </span>
      )}
      {data?.incluyeMesAbierto && <span className="block text-xs text-warn">⚠ Incluye el mes en curso: sus cifras cambian hasta el cierre.</span>}
    </>
  );

  return (
    <div className="space-y-8">
      <PageHeader title="Rotación de inventario" subtitle={subtitle} />

      <div className="flex flex-wrap items-center gap-2">
        <FilterButton active={preset === 'mes'} onClick={() => elegirPreset('mes')}>Último mes</FilterButton>
        <FilterButton active={preset === 'trimestre'} onClick={() => elegirPreset('trimestre')}>Últimos 3 meses</FilterButton>
        <FilterButton active={preset === 'semestre'} onClick={() => elegirPreset('semestre')}>Últimos 6 meses</FilterButton>
        <FilterButton active={preset === 'rango'} onClick={() => elegirPreset('rango')}>Rango</FilterButton>
        {preset === 'rango' && (
          <span className="flex items-center gap-2 text-sm text-ink-muted">
            <label className="sr-only" htmlFor="rot-desde">Desde</label>
            <select id="rot-desde" className={SELECT} value={rango.desde}
              onChange={(e) => setRango({ desde: e.target.value, hasta: e.target.value > rango.hasta ? e.target.value : rango.hasta })}>
              {mesesOpc.map((m) => <option key={m} value={m}>{mesCorto(m)}</option>)}
            </select>
            a
            <label className="sr-only" htmlFor="rot-hasta">Hasta</label>
            <select id="rot-hasta" className={SELECT} value={rango.hasta}
              onChange={(e) => setRango({ desde: e.target.value < rango.desde ? e.target.value : rango.desde, hasta: e.target.value })}>
              {mesesOpc.map((m) => <option key={m} value={m}>{mesCorto(m)}</option>)}
            </select>
          </span>
        )}
        <span className="mx-1 hidden h-6 w-px bg-line sm:inline-block" />
        <label className="sr-only" htmlFor="rot-bodega">Bodega</label>
        <select id="rot-bodega" className={SELECT} value={bodega} onChange={(e) => setBodega(e.target.value)}>
          {BODEGAS.map((b) => <option key={b.id} value={b.id}>{b.texto}</option>)}
        </select>
        <label className="flex items-center gap-2 text-sm text-ink-muted" htmlFor="rot-dias">
          Comprar para
          <select id="rot-dias" className={SELECT} value={dias} onChange={(e) => setDias(Number(e.target.value))}>
            {DIAS.map((d) => <option key={d} value={d}>{d} días</option>)}
          </select>
        </label>
      </div>

      {data && !data.completo && !cargando && (
        <Card>
          <EmptyState
            title="Este periodo todavía se está cargando desde HGI"
            hint={
              data.mesesSinDatos.length
                ? `Faltan ${data.mesesSinDatos.map(mesCorto).join(', ')}. La carga avanza sola (dos meses por hora aprox.). Inicial y final se calculan hacia atrás desde la existencia de hoy, por eso hacen falta todos los meses hasta hoy.`
                : 'Falta la primera toma de existencias de HGI; llega con la próxima actualización.'
            }
          />
        </Card>
      )}

      {data?.completo && k && (
        <>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <KpiCard label="Inventario a costo hoy" {...kpiMoney(k.valorExistencia)} hint={`${miles(k.productos)} productos · todas las bodegas`} />
            <KpiCard
              label="Días en inventario"
              value={k.diasInventario === null ? '—' : `${dec(k.diasInventario, 0)} días`}
              tone="accent"
              hint="Promedio del periodo, ponderado por costo"
            />
            <KpiCard
              label="Agotados y por agotarse"
              value={`${miles(k.agotados)} · ${miles(k.porAgotarse)}`}
              tone={k.agotados + k.porAgotarse > 0 ? 'danger' : 'neutral'}
              hint="Se venden y hoy no hay, o alcanzan para menos de 15 días"
            />
            <KpiCard
              label={`Sugerido para ${data.diasObjetivo} días`}
              {...kpiMoney(k.valorSugerido)}
              tone="warn"
              hint={`Sin movimiento: ${miles(k.sinMovimiento)} productos, ${formatPrice(k.valorSinMovimiento)}`}
            />
          </div>

          <section className="space-y-3">
            <SectionTitle>Por proveedor</SectionTitle>
            <Card>
              <div className="max-h-[28rem] overflow-auto">
                <table className="w-full text-xs sm:text-sm">
                  <thead className="sticky top-0 bg-surface-muted">
                    <tr>
                      <Th>Proveedor</Th>
                      <Th align="right" className={SOLO_MD}>Productos</Th>
                      <Th align="right">Inventario hoy</Th>
                      <Th align="right" className={SOLO_MD}>Días inv.</Th>
                      <Th align="right" className={SOLO_LG}>Agotados</Th>
                      <Th align="right" className={SOLO_LG}>Por agotarse</Th>
                      <Th align="right" className={SOLO_LG}>Sin mov.</Th>
                      <Th align="right">Sugerido</Th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line">
                    {data.proveedores.map((p) => {
                      const activo = proveedor === p.nit;
                      return (
                        <tr
                          key={p.nit || '(sin)'}
                          className={`cursor-pointer transition-colors hover:bg-surface-hover ${activo ? 'bg-surface-hover' : ''}`}
                          onClick={() => {
                            setProveedor(activo ? null : p.nit);
                            if (!activo) document.getElementById('rot-productos')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                          }}
                          aria-pressed={activo}
                        >
                          <td className="px-4 py-2.5">
                            <div className={`font-medium ${activo ? 'text-accent' : 'text-ink'}`}>{p.nombre}</div>
                            {p.nit && <div className="tabular text-[11px] text-ink-faint">NIT {p.nit}</div>}
                          </td>
                          <td className={`tabular px-4 py-2.5 text-right text-ink-muted ${SOLO_MD}`}>{miles(p.productos)}</td>
                          <td className="tabular px-4 py-2.5 text-right text-ink">{formatPrice(p.valorExistencia)}</td>
                          <td className={`tabular px-4 py-2.5 text-right text-ink ${SOLO_MD}`}>{dec(p.diasInventario, 0)}</td>
                          <td className={`tabular px-4 py-2.5 text-right ${p.agotados ? 'text-danger' : 'text-ink-faint'} ${SOLO_LG}`}>{p.agotados || '—'}</td>
                          <td className={`tabular px-4 py-2.5 text-right ${p.porAgotarse ? 'text-warn' : 'text-ink-faint'} ${SOLO_LG}`}>{p.porAgotarse || '—'}</td>
                          <td className={`tabular px-4 py-2.5 text-right text-ink-muted ${SOLO_LG}`}>{p.sinMovimiento || '—'}</td>
                          <td className="tabular px-4 py-2.5 text-right text-ink">{p.valorSugerido ? formatPrice(p.valorSugerido) : '—'}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </Card>
            <p className="text-xs text-ink-faint">Toque un proveedor para ver sólo sus productos.</p>
          </section>

          <section className="space-y-3" id="rot-productos">
            <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
              <SectionTitle>
                Productos{nombreProv ? ` · ${nombreProv}` : ''}
              </SectionTitle>
              <div className="flex flex-wrap items-center gap-2">
                {proveedor !== null && (
                  <FilterButton active onClick={() => setProveedor(null)}>Quitar proveedor ✕</FilterButton>
                )}
                <input
                  type="search"
                  value={busqueda}
                  onChange={(e) => setBusqueda(e.target.value)}
                  placeholder="Buscar producto o código"
                  aria-label="Buscar producto o código"
                  className="w-52 rounded border border-line bg-surface px-3 py-1.5 text-sm text-ink placeholder:text-ink-faint"
                />
                <label className="sr-only" htmlFor="rot-orden">Ordenar</label>
                <select id="rot-orden" className={SELECT} value={orden} onChange={(e) => setOrden(e.target.value as Orden)}>
                  {(Object.keys(ORDEN) as Orden[]).map((o) => <option key={o} value={o}>{ORDEN[o]}</option>)}
                </select>
                {reporte && (
                  <a
                    href={reporte}
                    className="inline-flex items-center rounded border border-accent bg-accent px-3 py-1.5 text-xs font-medium text-ink-inverse transition-colors hover:bg-accent-dark"
                  >
                    Descargar Excel
                  </a>
                )}
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              {([['todos', 'Todos'], ['alerta', 'Agotados y por agotarse'], ['sobrestock', 'Sobrestock'], ['sin_movimiento', 'Sin movimiento']] as const).map(
                ([id, texto]) => (
                  <FilterButton key={id} active={estado === id} onClick={() => setEstado(id)}>{texto}</FilterButton>
                ),
              )}
            </div>
            <Card>
              <div className="overflow-x-auto">
                <table className="w-full text-xs sm:text-sm">
                  <thead className="bg-surface-muted">
                    <tr>
                      <Th>Producto</Th>
                      <Th align="right" className={SOLO_MD}>Inicial</Th>
                      <Th align="right" className={SOLO_MD}>Entradas</Th>
                      <Th align="right" className={SOLO_MD}>Salidas</Th>
                      <Th align="right" className={SOLO_MD}>Final</Th>
                      <Th align="right">Días inv.</Th>
                      <Th align="right" className={SOLO_LG}>Existencia empresa</Th>
                      <Th align="right" className={SOLO_LG}>Cobertura</Th>
                      <Th align="right">Sugerido</Th>
                      <Th align="center" className={SOLO_MD}>Estado</Th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line">
                    {productos.slice(0, limite).map((p) => (
                      <tr key={p.codigo} className="hover:bg-surface-hover">
                        <td className="px-4 py-2.5">
                          <div className="text-ink">{p.nombre}</div>
                          <div className="tabular text-[11px] text-ink-faint">
                            {p.codigo}
                            {proveedor === null && p.nombreProveedor ? ` · ${p.nombreProveedor}` : ''}
                          </div>
                          <div className="mt-1 md:hidden">
                            <Badge tone={ESTADO[p.estado].tone}>{ESTADO[p.estado].texto}</Badge>
                          </div>
                        </td>
                        <td className={`tabular px-4 py-2.5 text-right text-ink-muted ${SOLO_MD}`}>{dec(p.inicial)}</td>
                        <td className={`tabular px-4 py-2.5 text-right text-ink ${SOLO_MD}`} title={`Compras: ${dec(p.compras)}`}>{dec(p.entradas)}</td>
                        <td className={`tabular px-4 py-2.5 text-right text-ink ${SOLO_MD}`} title={`Ventas netas: ${dec(p.ventasNetas)}`}>{dec(p.salidas)}</td>
                        <td className={`tabular px-4 py-2.5 text-right text-ink ${SOLO_MD}`}>{dec(p.final)}</td>
                        <td className="tabular px-4 py-2.5 text-right text-ink" title={p.rotacion === null ? undefined : `Rota ${dec(p.rotacion, 2)} veces en el periodo`}>
                          {dec(p.diasInventario, 0)}
                        </td>
                        <td className={`tabular px-4 py-2.5 text-right text-ink ${SOLO_LG}`}>{dec(p.existencia)}</td>
                        <td className={`tabular px-4 py-2.5 text-right ${SOLO_LG} ${p.cobertura !== null && p.cobertura < 15 ? 'text-danger' : 'text-ink-muted'}`}>
                          {p.cobertura === null ? '—' : `${dec(p.cobertura, 0)} d`}
                        </td>
                        <td className={`tabular px-4 py-2.5 text-right ${p.sugerido ? 'font-medium text-ink' : 'text-ink-faint'}`}
                          title={p.sugerido ? `${formatPrice(p.sugerido * p.costoUnitario)} a costo` : undefined}>
                          {p.sugerido ? miles(p.sugerido) : '—'}
                        </td>
                        <td className={`px-4 py-2.5 text-center ${SOLO_MD}`}>
                          <Badge tone={ESTADO[p.estado].tone}>{ESTADO[p.estado].texto}</Badge>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {productos.length === 0 && <EmptyState title="Ningún producto coincide" />}
              </div>
            </Card>
            {productos.length > limite && (
              <div className="flex items-center gap-3">
                <FilterButton active={false} onClick={() => setLimite(limite + PAGINA)}>Mostrar más</FilterButton>
                <span className="text-xs text-ink-faint">{miles(limite)} de {miles(productos.length)} productos</span>
              </div>
            )}
            <p className="text-xs leading-relaxed text-ink-faint">
              Unidades de HGI. <strong className="font-medium">Final</strong> = inicial + entradas − salidas.{' '}
              <strong className="font-medium">Días en inventario</strong> = inventario promedio ((inicial + final) ÷ 2) ÷ salidas ×
              días del periodo: cuántos días tarda en salir el inventario.{' '}
              Inicial, entradas, salidas, final y días son de la bodega elegida (igual al informe de HGI).{' '}
              <strong className="font-medium">Existencia, cobertura, sugerido y estado</strong> son de la empresa (todas las
              bodegas), porque la compra es una sola: así un producto que pasó a otra bodega no sale como agotado.{' '}
              <strong className="font-medium">Cobertura</strong> = existencia de hoy ÷ venta diaria del periodo (ventas menos
              devoluciones): para cuántos días alcanza. <strong className="font-medium">Sugerido</strong> = unidades para cubrir los
              días elegidos al ritmo de venta del periodo, menos la existencia de hoy.{' '}
              <strong className="font-medium">Por agotarse</strong>: menos de 15 días de cobertura.{' '}
              <strong className="font-medium">Sobrestock</strong>: más de 120 días. Con «Todas las bodegas» los traslados entre
              bodegas no cuentan como entrada ni salida.
            </p>
          </section>
        </>
      )}
    </div>
  );
}
