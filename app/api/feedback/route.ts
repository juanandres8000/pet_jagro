import { NextResponse } from 'next/server';
import { getSql as getDb } from '@/lib/pg';

// postgres.js abre conexiones TCP: esta ruta debe correr en Node, no en edge.
export const runtime = 'nodejs';

// Inicializar tabla si no existe
async function initTable() {
  const sql = getDb();
  await sql`
    CREATE TABLE IF NOT EXISTS chat_feedback (
      id SERIAL PRIMARY KEY,
      message_id TEXT NOT NULL,
      user_message TEXT,
      assistant_response TEXT,
      rating TEXT CHECK (rating IN ('up', 'down')),
      created_at TIMESTAMP DEFAULT NOW()
    )
  `;
}

export async function POST(req: Request) {
  try {
    await initTable();
    const sql = getDb();
    const { messageId, userMessage, assistantResponse, rating } = await req.json();

    await sql`
      INSERT INTO chat_feedback (message_id, user_message, assistant_response, rating)
      VALUES (${messageId}, ${userMessage}, ${assistantResponse}, ${rating})
    `;

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Feedback error:', error);
    return NextResponse.json({ error: 'Failed to save feedback' }, { status: 500 });
  }
}

export async function GET(req: Request) {
  try {
    await initTable();
    const sql = getDb();

    const { searchParams } = new URL(req.url);
    const type = searchParams.get('type');

    if (type === 'stats') {
      const result = await sql`
        SELECT
          COUNT(*) FILTER (WHERE rating = 'up') as upvotes,
          COUNT(*) FILTER (WHERE rating = 'down') as downvotes,
          COUNT(*) as total
        FROM chat_feedback
      `;
      return NextResponse.json(result[0]);
    }

    const feedback = await sql`SELECT * FROM chat_feedback ORDER BY created_at DESC LIMIT 50`;
    return NextResponse.json(feedback);
  } catch (error) {
    return NextResponse.json({ error: 'Failed to fetch feedback' }, { status: 500 });
  }
}
