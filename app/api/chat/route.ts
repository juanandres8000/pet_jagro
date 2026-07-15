import { NextResponse } from 'next/server';
import { createOpenAI } from '@ai-sdk/openai';
import { streamText, convertToModelMessages } from 'ai';
import { orders, products, deliveries } from '@/lib/mockData';

const openai = createOpenAI({
  apiKey: process.env.OPEN_AI_KEY,
});

export const maxDuration = 30;

/**
 * Chat deshabilitado mientras responda sobre mockData: el widget está oculto
 * (ver CLAUDE.md) y dejar la ruta abierta significaba que cualquiera podía
 * seguir haciéndole POST y gastar GPT-4o para recibir pedidos y stock
 * inventados. Se apaga por defecto: sin la variable, la ruta responde 503.
 *
 * Para reactivar en el sprint de migración: CHAT_ENABLED=true en el entorno
 * (y antes migrar lib/ai-functions.ts a HGINet, o el mock vuelve a pantalla).
 * El handler original se conserva íntegro debajo del guard.
 */
const CHAT_ENABLED = process.env.CHAT_ENABLED === 'true';

export async function POST(req: Request) {
  // Antes de leer el body y de tocar OpenAI: ningún token se gasta si está off.
  if (!CHAT_ENABLED) {
    return NextResponse.json(
      { ok: false, mensaje: 'Chat deshabilitado temporalmente' },
      { status: 503 },
    );
  }

  const { messages } = await req.json();

  // Convertir UIMessage[] a ModelMessage[]
  const modelMessages = convertToModelMessages(messages);

  const systemPrompt = `Eres el Asistente J Agro, experto en picking y distribución de productos veterinarios.

FECHA ACTUAL: ${new Date().toLocaleDateString('es-CO', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}

=== PEDIDOS ===
${JSON.stringify(orders, null, 2)}

=== INVENTARIO ===
${JSON.stringify(products, null, 2)}

=== LIQUIDACIONES ===
${JSON.stringify(deliveries, null, 2)}

REGLAS:
- IDs parciales: "2025-001" = "PED-2025-001"
- "en proceso"/"en curso" = estado "En proceso" o "En Curso"
- Interpreta "hoy", "ayer", fechas naturales
- Búsqueda flexible en nombres (cliente, producto, mensajero)
- Formato dinero colombiano: $1.230.000
- Respuestas concisas con emojis (📦 🚚 ✅ ⚠️ 💰)
- Si no encuentras algo, sugiere alternativas`;

  const result = streamText({
    model: openai('gpt-4o'),
    system: systemPrompt,
    messages: modelMessages,
  });

  return result.toUIMessageStreamResponse();
}
