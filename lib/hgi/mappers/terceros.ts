/**
 * Mapper: objeto Tercero de HGINet (Api/Terceros/Obtener) → tipo Cliente.
 *
 * No existe un tipo Cliente compartido en el dashboard (el customer vive inline
 * en Order). Se define aquí un DTO Cliente autocontenido para la vista de Clientes,
 * sin tocar types/index.ts.
 *
 * Lectura tolerante (el manual tuvo discrepancias): defaults sensatos en faltantes,
 * y se descartan placeholders basura de HGINet ("0", "" en email/teléfono/etc.).
 */

export interface HgiTercero {
  NumeroIdentificacion?: string | number;
  TipoIdentificacion?: string;
  DigitoVerificacion?: number | string;
  Nombre?: string;
  NombreComercial?: string;
  CodigoTipoPersona?: number | string; // 1 Natural, 2 Jurídica
  Direccion?: string;
  CodigoCiudad?: string | number;
  DescripcionCiudad?: string;
  Telefono?: string | number;
  Celular?: string | number;
  Email?: string;
  EmailFacturaElectronica?: string;
  CodigoVendedor?: string | number;
  Cupo?: number | string;
  Plazo?: number | string;
  Descuento?: number | string;
  Estado?: number | string;
  FechaUltimaNegociacion?: string;
  CodigoTipoTercero?: string | number;
  // Campos de texto libre donde el ERP mete alertas de cartera/bloqueo.
  // DireccionAlterna es campo de dirección, pero se abusa para "NO DESPACHAR" etc.
  Observaciones?: string;
  DireccionAlterna?: string;
  [key: string]: unknown;
}

/** DTO que consumirá la vista de Clientes. */
export interface Cliente {
  id: string; // NumeroIdentificacion
  identificacion: string; // NumeroIdentificacion (con DV si aplica)
  tipoIdentificacion: string; // NI / CC / CE / DE …
  nombre: string;
  nombreComercial?: string;
  tipoPersona: 'natural' | 'juridica';
  direccion?: string;
  ciudad?: string;
  telefono?: string;
  email?: string;
  codigoVendedor?: string;
  cupo: number; // cupo de crédito (Cupo, estructurado)
  plazo: number; // días de plazo (Plazo, estructurado)
  descuento: number;
  estado: number; // Estado crudo del ERP (1 activo, 0 suspendido)
  activo: boolean; // Estado === 1
  // Alerta de cartera/bloqueo derivada del texto libre del tercero (+ Estado=0).
  alertaCartera: boolean;
  motivoAlerta: string | null; // texto crudo de los campos que dispararon la alerta
  codigoTipoTercero: string; // crudo (0..7)
  tipoTerceroDescripcion?: string; // resuelto contra Api/TercerosTipo (ej: "CLIENTES GENERALES")
  fechaUltimaNegociacion?: string;
}

const str = (v: unknown): string => (v === undefined || v === null ? '' : String(v).trim());

const num = (v: unknown, def = 0): number => {
  if (v === undefined || v === null || v === '') return def;
  const n = typeof v === 'number' ? v : Number(String(v).replace(',', '.'));
  return Number.isFinite(n) ? n : def;
};

/** Limpia placeholders basura de HGINet: "0", "" → undefined. */
const clean = (v: unknown): string | undefined => {
  const s = str(v);
  return s === '' || s === '0' ? undefined : s;
};

function tipoPersona(v: unknown): Cliente['tipoPersona'] {
  return num(v) === 2 ? 'juridica' : 'natural';
}

/**
 * Patrones de alerta de cartera. Case-insensitive y tolerantes a typos comunes
 * (letras repetidas, espaciado variable) vistos en datos reales de HGINet:
 * "noooooo despachar", "NO MAS PEDIDOS HASTA VAJAR CARTERA", "SOLO POS", etc.
 */
const ALERTA_PATRONES: RegExp[] = [
  /n+o+\s*despach/i, // NO DESPACHAR  (tolera "noooooo despachar", "nodespachar")
  /cart[eé]ra/i, //     CARTERA
  /suspend/i, //         SUSPENDIDO / SUSPENDER
  /solo\s*pos/i, //      SOLO POS
  /pago\s*anticip/i, //  PAGO ANTICIPADO
  /vencid/i, //          VENCIDAS / VENCIDO
  /n+o+\s*factur/i, //   NO FACTURAR
  /\bojo+\b/i, //        OJO  (tolera "ojooo")
];

/** Campos de texto libre del tercero donde el ERP mete alertas. */
const CAMPOS_ALERTA: Array<keyof HgiTercero> = ['Observaciones', 'DireccionAlterna'];

/**
 * Deriva la alerta de cartera parseando Observaciones + DireccionAlterna contra
 * los patrones, y marca también Estado=0 (suspendido en el ERP).
 * `motivo` = texto CRUDO concatenado de los campos que dispararon.
 */
function derivarAlerta(t: HgiTercero, estado: number): { alerta: boolean; motivo: string | null } {
  const motivos: string[] = [];
  for (const campo of CAMPOS_ALERTA) {
    const texto = str(t[campo]);
    if (texto && texto !== '0' && ALERTA_PATRONES.some((re) => re.test(texto))) {
      motivos.push(texto); // crudo, tal cual viene
    }
  }
  // Estado=0 es alerta por sí mismo, aunque no haya texto de alerta.
  if (estado === 0) motivos.push('SUSPENDIDO EN ERP');
  return { alerta: motivos.length > 0, motivo: motivos.length ? motivos.join(' · ') : null };
}

/** Mapea UN Tercero → Cliente. `tipos` resuelve CodigoTipoTercero → descripción. */
export function mapTercero(t: HgiTercero, tipos?: Map<string, string>): Cliente {
  const id = str(t.NumeroIdentificacion);
  const dv = num(t.DigitoVerificacion);
  const codigoTipo = str(t.CodigoTipoTercero);
  const estado = num(t.Estado);
  const { alerta, motivo } = derivarAlerta(t, estado);
  return {
    id,
    identificacion: dv > 0 ? `${id}-${dv}` : id,
    tipoIdentificacion: str(t.TipoIdentificacion) || 'NI',
    nombre: str(t.Nombre) || str(t.NombreComercial) || id || 'Sin nombre',
    nombreComercial: clean(t.NombreComercial),
    tipoPersona: tipoPersona(t.CodigoTipoPersona),
    direccion: clean(t.Direccion),
    // Ciudad por nombre; fallback al código.
    ciudad: clean(t.DescripcionCiudad) ?? clean(t.CodigoCiudad),
    // Teléfono fijo; fallback celular.
    telefono: clean(t.Telefono) ?? clean(t.Celular),
    // Email principal; fallback el de factura electrónica.
    email: clean(t.Email) ?? clean(t.EmailFacturaElectronica),
    codigoVendedor: clean(t.CodigoVendedor),
    cupo: num(t.Cupo),
    plazo: num(t.Plazo),
    descuento: num(t.Descuento),
    estado,
    activo: estado === 1,
    alertaCartera: alerta,
    motivoAlerta: motivo,
    codigoTipoTercero: codigoTipo,
    tipoTerceroDescripcion: tipos?.get(codigoTipo),
    fechaUltimaNegociacion: clean(t.FechaUltimaNegociacion),
  };
}

/** Mapea el array de Terceros → Cliente[]. Tolera array vacío/nulo. */
export function mapTerceros(raw: unknown, tipos?: Map<string, string>): Cliente[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((t): t is HgiTercero => !!t && typeof t === 'object').map((t) => mapTercero(t, tipos));
}
