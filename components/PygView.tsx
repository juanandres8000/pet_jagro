'use client';

import { Fragment, useEffect, useMemo, useState } from 'react';
import { PageHeader, SectionTitle, KpiCard, Card, Th, EmptyState, Badge } from '@/components/ui';
import { formatPrice, kpiMoney } from '@/lib/format';

/**
 * Vista P&G (estado de resultados) mensual.
 *
 * No calcula nada de negocio: todos los agregados llegan resueltos de /api/pyg,
 * que los lee de las vistas pyg_saldo_cuenta / pyg_mensual. Las reglas contables
 * —clase 4 = créditos − débitos, clases 5 y 6 = débitos − créditos, periodo 13
 * excluido— viven en migrations/008_pyg_vistas.sql.
 *
 * Lo único que se deriva aquí son los porcentajes de presentación (márgenes y
 * peso de cada gasto sobre ingresos) y las variaciones mes a mes, que salen de
 * comparar dos meses del propio listado.
 *
 * REGLA DURA: un mes que no está completo NO muestra cifras. El endpoint ya
 * filtra —sólo lista meses con ventana mensual ok— pero la vista vuelve a
 * comprobarlo con `completo`, porque enseñar el P&G de un mes a medio ingestar
 * es peor que no enseñar nada.
 */

const MESES_LARGO = [
  'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
  'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre',
];
const MESES_CORTO = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

/** 'YYYY-MM' → "junio 2026". */
const mesLargo = (mes: string) => {
  const [y, m] = mes.split('-');
  return `${MESES_LARGO[Number(m) - 1] ?? mes} ${y}`;
};
/** 'YYYY-MM' → "jun 26". */
const mesCorto = (mes: string) => {
  const [y, m] = mes.split('-');
  return `${MESES_CORTO[Number(m) - 1] ?? mes} ${y.slice(2)}`;
};

const pctFmt = (v: number) => `${(v * 100).toFixed(1)}%`;
/** Porcentaje sobre una base, tolerando base 0 (devuelve null, no Infinity). */
const ratio = (parte: number, base: number): number | null => (base === 0 ? null : parte / base);
const pctODash = (v: number | null) => (v === null ? '—' : pctFmt(v));

/** Variación relativa contra el mes anterior. null si no hay con qué comparar. */
function variacion(actual: number, anterior: number | undefined): string | undefined {
  if (anterior === undefined || anterior === 0) return undefined;
  const d = (actual - anterior) / Math.abs(anterior);
  const signo = d >= 0 ? '+' : '';
  return `${signo}${(d * 100).toFixed(1)}% vs mes anterior`;
}

// ---- Tipos de la respuesta de /api/pyg ----

interface Ingresos {
  brutas: number;
  devolucionesDescuentos: number;
  operacionalNeto: number;
  noOperacional: number;
  total: number;
}
interface Costo {
  valor: number;
  esFallback: boolean;
  fuente: string;
  contable: number;
  aviso?: string;
}
interface Integridad {
  diasEsperados: number;
  diasIngestados: number;
  completo: boolean;
  cuadraPartidaDoble: boolean;
  debitos: number;
  creditos: number;
}
interface Subcuenta {
  subcuenta: string;
  descripcion: string;
  saldo: number;
  lineas: number;
}
interface GrupoGasto {
  grupo: string;
  descripcion: string;
  saldo: number;
  subcuentas: Subcuenta[];
}
interface GastosResumen {
  total: number;
  admon: number;
  ventas: number;
  noOperacional: number;
}
interface MesListado {
  mes: string;
  ingresos: Ingresos;
  costo: Costo;
  gastos: GastosResumen;
  utilidadBruta: number;
  resultado: number;
  integridad: Integridad;
}
interface Listado {
  ok: boolean;
  count: number;
  meses: MesListado[];
  aviso?: string;
}
interface Detalle {
  ok: boolean;
  mes: string;
  completo: boolean;
  aviso?: string;
  ingresos?: Ingresos;
  costo?: Costo;
  gastos?: GastosResumen & { porGrupo: GrupoGasto[] };
  utilidadBruta?: number;
  resultado?: number;
  integridad?: Integridad;
}

// ---- Gráfico de tendencia ----

/**
 * Barras agrupadas ingresos / costo / gastos por mes, con el resultado como
 * línea sobre el mismo eje. Mismo lenguaje visual que el gráfico de Gerencia:
 * divs con las clases del tema, sin librería (el proyecto no tiene ninguna).
 *
 * El resultado puede ser negativo, así que la escala se calcula sobre el máximo
 * ABSOLUTO de todas las series y el cero se dibuja donde corresponde, en vez de
 * recortar las barras negativas contra el suelo.
 */
function GraficoTendencia({ meses, alto = 200 }: { meses: MesListado[]; alto?: number }) {
  if (!meses.length) return <EmptyState title="Sin meses completos todavía" />;

  const valores = meses.flatMap((m) => [m.ingresos.total, m.costo.valor, m.gastos.total, m.resultado]);
  const max = Math.max(1, ...valores.map(Math.abs));
  const hayNegativos = valores.some((v) => v < 0);
  // Con negativos el cero va a media altura; sin ellos, al fondo.
  const altoPos = hayNegativos ? alto / 2 : alto;
  const altoNeg = alto - altoPos;
  const escala = (v: number) => (Math.abs(v) / max) * altoPos;

  return (
    <div className="overflow-x-auto">
      <div className="flex min-w-full items-stretch gap-3 px-4 pb-2 pt-6">
        {meses.map((m) => {
          const res = m.resultado;
          return (
            <div key={m.mes} className="flex flex-1 flex-col" style={{ minWidth: 64 }}>
              <div className="relative flex flex-col" style={{ height: alto }}>
                {/* Zona positiva */}
                <div className="flex items-end justify-center gap-1" style={{ height: altoPos }}>
                  <div
                    className="w-full max-w-[16px] rounded-t bg-accent-light"
                    style={{ height: Math.max(2, escala(m.ingresos.total)) }}
                    title={`Ingresos ${formatPrice(m.ingresos.total)}`}
                  />
                  <div
                    className="w-full max-w-[16px] rounded-t bg-accent"
                    style={{ height: Math.max(2, escala(m.costo.valor)) }}
                    title={`Costo ${formatPrice(m.costo.valor)}${m.costo.esFallback ? ' (estimado)' : ''}`}
                  />
                  <div
                    className="w-full max-w-[16px] rounded-t bg-warn"
                    style={{ height: Math.max(2, escala(m.gastos.total)) }}
                    title={`Gastos ${formatPrice(m.gastos.total)}`}
                  />
                </div>
                {/* Línea de cero */}
                <div className="w-full border-t border-line-strong" />
                {/* Zona negativa */}
                <div className="flex items-start justify-center" style={{ height: altoNeg }} />
                {/* Marcador de resultado, posicionado respecto al cero */}
                <div
                  className="pointer-events-none absolute inset-x-0 flex justify-center"
                  style={{ top: res >= 0 ? altoPos - escala(res) - 3 : altoPos + escala(res) - 3 }}
                >
                  <span
                    className={`h-1.5 w-1.5 rounded-full ring-2 ring-surface ${res >= 0 ? 'bg-ink' : 'bg-danger'}`}
                    title={`Resultado ${formatPrice(res)}`}
                  />
                </div>
              </div>
              <div className="mt-1.5 text-center tabular text-[10px] text-ink-faint">{mesCorto(m.mes)}</div>
              <div
                className={`text-center tabular text-[10px] font-medium ${res >= 0 ? 'text-ink-muted' : 'text-danger'}`}
              >
                {Math.round(res / 1_000_000).toLocaleString('es-CO')} M
              </div>
            </div>
          );
        })}
      </div>
      <div className="flex flex-wrap items-center gap-4 border-t border-line px-4 py-2 text-xs text-ink-muted">
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-2.5 rounded-sm bg-accent-light" /> Ingresos
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-2.5 rounded-sm bg-accent" /> Costo
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-2.5 rounded-sm bg-warn" /> Gastos
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-1.5 w-1.5 rounded-full bg-ink" /> Resultado
        </span>
      </div>
    </div>
  );
}

// ---- Cascada del estado de resultados ----

type FilaTono = 'normal' | 'sub' | 'subtotal' | 'total';

function FilaCascada({
  etiqueta,
  valor,
  base,
  tipo = 'normal',
  sangria = 0,
  extra,
  expandible,
  abierto,
  onToggle,
}: {
  etiqueta: string;
  valor: number;
  base: number;
  tipo?: FilaTono;
  sangria?: number;
  extra?: React.ReactNode;
  expandible?: boolean;
  abierto?: boolean;
  onToggle?: () => void;
}) {
  const pct = ratio(valor, base);
  const clasesFila =
    tipo === 'total'
      ? 'border-t-2 border-line-strong bg-surface-muted font-semibold'
      : tipo === 'subtotal'
        ? 'border-t border-line-strong bg-cream/60 font-medium'
        : 'border-t border-line';
  const clasesValor =
    tipo === 'total'
      ? valor < 0
        ? 'text-danger'
        : 'text-ink'
      : tipo === 'sub'
        ? 'text-ink-muted'
        : 'text-ink';

  const Contenido = (
    <>
      <td className="px-4 py-2.5" style={{ paddingLeft: 16 + sangria * 20 }}>
        <span className={`inline-flex items-center gap-2 ${tipo === 'sub' ? 'text-ink-muted' : 'text-ink'}`}>
          {expandible && (
            <span className="tabular text-xs text-ink-faint">{abierto ? '▾' : '▸'}</span>
          )}
          {etiqueta}
          {extra}
        </span>
      </td>
      <td className={`tabular whitespace-nowrap px-4 py-2.5 text-right ${clasesValor}`}>{formatPrice(valor)}</td>
      <td className="tabular whitespace-nowrap px-4 py-2.5 text-right text-ink-faint">{pctODash(pct)}</td>
    </>
  );

  if (expandible) {
    return (
      <tr
        className={`${clasesFila} cursor-pointer hover:bg-surface-hover`}
        onClick={onToggle}
        aria-expanded={abierto}
      >
        {Contenido}
      </tr>
    );
  }
  return <tr className={clasesFila}>{Contenido}</tr>;
}

// ---- Vista ----

export default function PygView() {
  const [listado, setListado] = useState<Listado | null>(null);
  const [mes, setMes] = useState<string>('');
  const [detalle, setDetalle] = useState<Detalle | null>(null);
  const [loadingListado, setLoadingListado] = useState(true);
  const [loadingMes, setLoadingMes] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [abiertos, setAbiertos] = useState<Record<string, boolean>>({});

  // Listado: define qué meses son seleccionables y alimenta la tendencia.
  useEffect(() => {
    let vivo = true;
    setLoadingListado(true);
    fetch('/api/pyg')
      .then((r) => r.json())
      .then((d: Listado) => {
        if (!vivo) return;
        setListado(d);
        // Por defecto, el mes completo más reciente. El endpoint ya los devuelve
        // del más nuevo al más viejo.
        if (d.meses?.length) setMes((actual) => actual || d.meses[0].mes);
        setError(null);
      })
      .catch((e: Error) => vivo && setError(e.message))
      .finally(() => vivo && setLoadingListado(false));
    return () => {
      vivo = false;
    };
  }, []);

  // Detalle del mes seleccionado.
  useEffect(() => {
    if (!mes) return;
    let vivo = true;
    setLoadingMes(true);
    setAbiertos({});
    fetch(`/api/pyg?mes=${mes}`)
      .then((r) => r.json())
      .then((d: Detalle) => {
        if (!vivo) return;
        setDetalle(d);
        setError(null);
      })
      .catch((e: Error) => vivo && setError(e.message))
      .finally(() => vivo && setLoadingMes(false));
    return () => {
      vivo = false;
    };
  }, [mes]);

  const mesesDisponibles = listado?.meses ?? [];
  // Mes anterior EN EL LISTADO, para las variaciones. Si el mes previo no está
  // completo no aparece aquí y las KPI salen sin delta, que es lo correcto:
  // comparar contra un mes a medio ingestar inventaría una variación.
  const anterior = useMemo(() => {
    const i = mesesDisponibles.findIndex((m) => m.mes === mes);
    return i >= 0 ? mesesDisponibles[i + 1] : undefined;
  }, [mesesDisponibles, mes]);

  // Tendencia: del más viejo al más nuevo para que el eje lea de izquierda a derecha.
  const tendencia = useMemo(() => [...mesesDisponibles].reverse(), [mesesDisponibles]);

  const toggle = (g: string) => setAbiertos((a) => ({ ...a, [g]: !a[g] }));

  const completo = detalle?.completo === true;
  const ing = detalle?.ingresos;
  const costo = detalle?.costo;
  const gastos = detalle?.gastos;
  const integridad = detalle?.integridad;

  const margenBruto = ing && detalle?.utilidadBruta !== undefined
    ? ratio(detalle.utilidadBruta, ing.operacionalNeto)
    : null;
  const margenNeto = ing && detalle?.resultado !== undefined ? ratio(detalle.resultado, ing.total) : null;
  const margenBrutoAnt = anterior ? ratio(anterior.utilidadBruta, anterior.ingresos.operacionalNeto) : null;

  return (
    <div className="space-y-8">
      <PageHeader
        title="P&G"
        subtitle={
          <>
            Estado de resultados mensual desde el movimiento contable del ERP.
            {loadingListado && <span className="block">Cargando meses disponibles…</span>}
            {error && <span className="block text-danger">No se pudo cargar: {error}</span>}
            {listado?.aviso && <span className="block text-warn">{listado.aviso}</span>}
          </>
        }
        actions={
          mesesDisponibles.length > 0 && (
            <select
              value={mes}
              onChange={(e) => setMes(e.target.value)}
              className="rounded border border-line bg-surface px-3 py-1.5 text-sm text-ink"
              aria-label="Mes"
            >
              {mesesDisponibles.map((m) => (
                <option key={m.mes} value={m.mes}>
                  {mesLargo(m.mes)}
                </option>
              ))}
            </select>
          )
        }
      />

      {/* Sin ningún mes completo: el backfill todavía no llegó. */}
      {!loadingListado && !error && mesesDisponibles.length === 0 && (
        <Card>
          <EmptyState
            title="Todavía no hay ningún mes completo"
            hint="El P&G se publica sólo cuando el mes está ingestado entero. El backfill los va cubriendo de a uno."
          />
        </Card>
      )}

      {loadingMes && !detalle && mesesDisponibles.length > 0 && (
        <Card>
          <EmptyState title="Calculando el estado de resultados…" />
        </Card>
      )}

      {/* Mes incompleto: aviso, sin cifras. */}
      {detalle && !completo && (
        <Card className="border-warn/30 bg-warn-soft">
          <div className="px-4 py-6">
            <div className="font-medium text-warn">{mesLargo(detalle.mes)} no está completo</div>
            <p className="mt-1 text-sm text-ink-muted">
              {detalle.aviso ?? 'No se muestran cifras de un mes que no se ingestó entero.'}
            </p>
          </div>
        </Card>
      )}

      {completo && ing && costo && gastos && detalle && (
        <>
          {/* Partida doble descuadrada: la contabilidad del mes no cierra. */}
          {integridad && !integridad.cuadraPartidaDoble && (
            <Card className="border-warn/30 bg-warn-soft">
              <div className="px-4 py-4">
                <div className="font-medium text-warn">La partida doble de {mesLargo(detalle.mes)} no cuadra</div>
                <p className="mt-1 text-sm text-ink-muted">
                  Débitos <span className="tabular">{formatPrice(integridad.debitos)}</span> contra créditos{' '}
                  <span className="tabular">{formatPrice(integridad.creditos)}</span> — diferencia{' '}
                  <span className="tabular font-medium">
                    {formatPrice(integridad.debitos - integridad.creditos)}
                  </span>
                  . Las cifras de abajo salen igual del movimiento tal cual lo devuelve el ERP.
                </p>
              </div>
            </Card>
          )}

          {/* KPIs */}
          <section className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
            <KpiCard
              label="Ingresos totales"
              {...kpiMoney(ing.total)}
              delta={variacion(ing.total, anterior?.ingresos.total)}
            />
            <KpiCard
              label="Costo de ventas"
              {...kpiMoney(costo.valor)}
              delta={variacion(costo.valor, anterior?.costo.valor)}
              tone={costo.esFallback ? 'warn' : 'neutral'}
              hint={
                costo.esFallback
                  ? 'Costo estimado por facturación, pendiente cierre contable'
                  : 'Costo contable del asiento de cierre'
              }
            />
            <KpiCard
              label="Utilidad bruta"
              {...kpiMoney(detalle.utilidadBruta ?? 0)}
              delta={variacion(detalle.utilidadBruta ?? 0, anterior?.utilidadBruta)}
              tone={(detalle.utilidadBruta ?? 0) < 0 ? 'danger' : 'neutral'}
            />
            <KpiCard
              label="Margen bruto"
              value={pctODash(margenBruto)}
              delta={
                margenBruto !== null && margenBrutoAnt !== null
                  ? `${margenBruto - margenBrutoAnt >= 0 ? '+' : ''}${((margenBruto - margenBrutoAnt) * 100).toFixed(1)} pp vs mes anterior`
                  : undefined
              }
              tone={margenBruto !== null && margenBruto < 0 ? 'danger' : 'neutral'}
              hint="Sobre ingresos operacionales netos"
            />
            <KpiCard
              label="Gastos totales"
              {...kpiMoney(gastos.total)}
              delta={variacion(gastos.total, anterior?.gastos.total)}
            />
            <KpiCard
              label="Resultado"
              {...kpiMoney(detalle.resultado ?? 0)}
              delta={variacion(detalle.resultado ?? 0, anterior?.resultado)}
              tone={(detalle.resultado ?? 0) < 0 ? 'danger' : 'accent'}
              hint={`Margen neto ${pctODash(margenNeto)} sobre ingresos totales`}
            />
          </section>

          {/* Aviso del costo estimado */}
          {costo.esFallback && (
            <Card className="border-warn/30">
              <div className="flex flex-wrap items-center gap-3 px-4 py-3">
                <Badge tone="warn">Costo estimado</Badge>
                <span className="text-sm text-ink-muted" title={costo.aviso}>
                  Costo estimado por facturación, pendiente cierre contable.
                </span>
                {costo.aviso && <span className="text-xs text-ink-faint">{costo.aviso}</span>}
              </div>
            </Card>
          )}

          {/* Cascada */}
          <section className="space-y-3">
            <SectionTitle>Estado de resultados · {mesLargo(detalle.mes)}</SectionTitle>
            <Card>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-surface-muted">
                    <tr>
                      <Th>Concepto</Th>
                      <Th align="right">Valor</Th>
                      <Th align="right">% ingresos</Th>
                    </tr>
                  </thead>
                  <tbody>
                    <FilaCascada etiqueta="Ventas brutas" valor={ing.brutas} base={ing.total} />
                    <FilaCascada
                      etiqueta="Devoluciones y descuentos"
                      valor={ing.devolucionesDescuentos}
                      base={ing.total}
                      tipo="sub"
                      sangria={1}
                    />
                    <FilaCascada
                      etiqueta="Ingreso operacional neto"
                      valor={ing.operacionalNeto}
                      base={ing.total}
                      tipo="subtotal"
                    />
                    <FilaCascada etiqueta="Ingreso no operacional" valor={ing.noOperacional} base={ing.total} />
                    <FilaCascada etiqueta="Ingresos totales" valor={ing.total} base={ing.total} tipo="subtotal" />
                    <FilaCascada
                      etiqueta="Costo de ventas"
                      valor={-costo.valor}
                      base={ing.total}
                      extra={costo.esFallback ? <Badge tone="warn">estimado</Badge> : undefined}
                    />
                    <FilaCascada
                      etiqueta="Utilidad bruta"
                      valor={detalle.utilidadBruta ?? 0}
                      base={ing.total}
                      tipo="subtotal"
                    />

                    {/* Cada grupo va seguido INMEDIATAMENTE de sus subcuentas
                        cuando está abierto. Renderizarlas en un bloque aparte
                        las mandaba al final de la tabla, debajo del grupo 53. */}
                    {gastos.porGrupo.map((g) => (
                      <Fragment key={g.grupo}>
                        <FilaCascada
                          etiqueta={`${g.grupo} · ${g.descripcion}`}
                          valor={-g.saldo}
                          base={ing.total}
                          expandible={g.subcuentas.length > 0}
                          abierto={!!abiertos[g.grupo]}
                          onToggle={() => toggle(g.grupo)}
                        />
                        {abiertos[g.grupo] &&
                          // Ya vienen ordenadas por saldo desc del endpoint; se
                          // reordena igual para no depender del orden del JSON.
                          [...g.subcuentas]
                            .sort((a, b) => b.saldo - a.saldo)
                            .map((s) => (
                              <FilaCascada
                                key={`${g.grupo}-${s.subcuenta}`}
                                etiqueta={`${s.subcuenta} · ${s.descripcion}`}
                                valor={-s.saldo}
                                base={ing.total}
                                tipo="sub"
                                sangria={1}
                              />
                            ))}
                      </Fragment>
                    ))}

                    <FilaCascada etiqueta="Gastos totales" valor={-gastos.total} base={ing.total} tipo="subtotal" />
                    <FilaCascada
                      etiqueta="Resultado del ejercicio"
                      valor={detalle.resultado ?? 0}
                      base={ing.total}
                      tipo="total"
                    />
                  </tbody>
                </table>
              </div>
            </Card>
            {gastos.porGrupo.length > 0 && (
              <p className="text-xs text-ink-faint">
                Los grupos de gasto se despliegan a subcuenta. Los porcentajes son sobre ingresos totales.
              </p>
            )}
          </section>
        </>
      )}

      {/* Tendencia */}
      {tendencia.length > 0 && (
        <section className="space-y-3">
          <SectionTitle>Tendencia · meses completos</SectionTitle>
          <Card>
            <GraficoTendencia meses={tendencia} />
          </Card>
        </section>
      )}
    </div>
  );
}
