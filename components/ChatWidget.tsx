'use client';

import { useState, useRef, useEffect } from 'react';
import { useChat } from '@ai-sdk/react';
import { DefaultChatTransport } from 'ai';

// Sugerencias de preguntas rápidas
const suggestions = [
  { icon: "📦", text: "¿Pedidos en proceso?" },
  { icon: "⚠️", text: "¿Productos con stock bajo?" },
  { icon: "💰", text: "Resumen de liquidaciones" },
  { icon: "🚚", text: "¿Pedidos para zona Norte?" },
  { icon: "🔍", text: "¿Qué tiene el pedido 2025-004?" }
];

export default function ChatWidget() {
  const [isOpen, setIsOpen] = useState(false);
  const [isExpanded, setIsExpanded] = useState(false);
  const [input, setInput] = useState('');
  const [feedbackGiven, setFeedbackGiven] = useState<Record<string, string>>({});
  const [stats, setStats] = useState<{ upvotes: number; downvotes: number; total: number } | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const { messages, sendMessage, status, setMessages } = useChat({
    transport: new DefaultChatTransport({
      api: '/api/chat',
    }),
  });

  const isLoading = status === 'streaming' || status === 'submitted';

  // Calculate satisfaction rate
  const satisfactionRate = stats && Number(stats.total) > 0
    ? Math.round((Number(stats.upvotes) / Number(stats.total)) * 100)
    : null;

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  // Load stats when component mounts or feedback is given
  useEffect(() => {
    fetch('/api/feedback?type=stats')
      .then(res => res.json())
      .then(data => {
        if (data && !data.error) {
          setStats(data);
        }
      })
      .catch(() => {
        // Silently fail - stats are not critical
      });
  }, [feedbackGiven]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || isLoading) return;

    const message = input;
    setInput('');
    await sendMessage({ text: message });
  };

  const handleSuggestionClick = async (text: string) => {
    if (isLoading) return;
    await sendMessage({ text });
  };

  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit(e);
    }
  };

  // Helper function to extract text content from message parts
  const getMessageText = (msg: typeof messages[0]): string => {
    // UIMessage v5 uses parts array
    if (Array.isArray(msg.parts)) {
      return msg.parts
        .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
        .map(part => part.text)
        .join('');
    }
    return '';
  };

  // Find the previous user message for context
  const getPreviousUserMessage = (index: number): string => {
    for (let i = index - 1; i >= 0; i--) {
      if (messages[i].role === 'user') {
        return getMessageText(messages[i]);
      }
    }
    return '';
  };

  // Send feedback to API
  const sendFeedback = async (messageId: string, rating: 'up' | 'down', userMsg: string, assistantMsg: string) => {
    setFeedbackGiven(prev => ({ ...prev, [messageId]: rating }));

    try {
      await fetch('/api/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messageId,
          userMessage: userMsg,
          assistantResponse: assistantMsg,
          rating
        })
      });
    } catch (error) {
      console.error('Error sending feedback:', error);
    }
  };

  return (
    <>
      {/* Floating Button */}
      <button
        onClick={() => setIsOpen(!isOpen)}
        aria-label={isOpen ? 'Cerrar asistente' : 'Abrir asistente'}
        className="fixed bottom-6 right-6 z-50 flex h-14 w-14 items-center justify-center rounded-full border border-accent bg-accent text-ink-inverse shadow-card transition-colors hover:bg-accent-dark"
      >
        {isOpen ? (
          <svg className="h-6 w-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        ) : (
          <svg className="h-6 w-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z" />
          </svg>
        )}
      </button>

      {/* Chat Window */}
      {isOpen && (
        <div
          className={`fixed bottom-24 right-6 z-50 flex flex-col overflow-hidden rounded-lg border border-line bg-surface shadow-card-hover transition-all duration-300 ${
            isExpanded
              ? 'w-[460px] h-[600px]'
              : 'w-96 h-[500px]'
          }`}
        >
          {/* Header */}
          <div className="flex items-center justify-between border-b border-line bg-surface px-4 py-3">
            <div className="flex items-center gap-2">
              <div className="h-1.5 w-1.5 rounded-full bg-accent"></div>
              <h3 className="font-serif text-base font-semibold tracking-tight text-ink">Asistente J Agro</h3>
              {satisfactionRate !== null && (
                <span
                  className="ml-1 rounded border border-accent/15 bg-accent-soft px-2 py-0.5 text-[11px] font-medium text-accent"
                  title={`Basado en ${stats?.total} valoraciones`}
                >
                  {satisfactionRate}% útil
                </span>
              )}
            </div>
            <div className="flex items-center gap-1">
              <button
                onClick={() => setIsExpanded(!isExpanded)}
                className="rounded p-1.5 text-ink-faint transition-colors hover:bg-surface-hover hover:text-ink"
                title={isExpanded ? 'Contraer' : 'Expandir'}
              >
                {isExpanded ? (
                  <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 9V4.5M9 9H4.5M9 9L3.75 3.75M9 15v4.5M9 15H4.5M9 15l-5.25 5.25M15 9h4.5M15 9V4.5M15 9l5.25-5.25M15 15h4.5M15 15v4.5m0-4.5l5.25 5.25" />
                  </svg>
                ) : (
                  <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5l-5-5m5 5v-4m0 4h-4" />
                  </svg>
                )}
              </button>
              <button
                onClick={() => {
                  setMessages([]);
                  setFeedbackGiven({});
                }}
                className="rounded px-2 py-1 text-xs font-medium text-ink-muted transition-colors hover:bg-surface-hover hover:text-ink"
              >
                Limpiar
              </button>
            </div>
          </div>

          {/* Messages */}
          <div className="flex-1 space-y-4 overflow-y-auto bg-cream-deep p-4">
            {messages.length === 0 && (
              <>
                <div className="mt-4 text-center text-sm text-ink-muted">
                  <p>Pregúntame sobre productos, pedidos,</p>
                  <p>mensajeros o inventario</p>
                </div>

                {/* Quick Suggestion Chips */}
                <div className="mt-6 flex flex-wrap justify-center gap-2">
                  {suggestions.map((suggestion, index) => (
                    <button
                      key={index}
                      onClick={() => handleSuggestionClick(suggestion.text)}
                      disabled={isLoading}
                      className="rounded border border-line bg-surface px-3 py-2 text-xs font-medium text-ink-muted transition-colors hover:bg-surface-hover hover:text-ink disabled:opacity-50"
                    >
                      <span className="mr-1.5">{suggestion.icon}</span>
                      {suggestion.text}
                    </button>
                  ))}
                </div>
              </>
            )}
            {messages.map((msg, index) => (
              <div
                key={msg.id}
                className={`flex flex-col ${msg.role === 'user' ? 'items-end' : 'items-start'}`}
              >
                <div
                  className={`max-w-[80%] whitespace-pre-wrap rounded-lg border px-3 py-2 text-sm leading-relaxed ${
                    msg.role === 'user'
                      ? 'border-accent bg-accent text-ink-inverse'
                      : 'border-line bg-surface-muted text-ink'
                  }`}
                >
                  {getMessageText(msg)}
                </div>

                {/* Feedback buttons for assistant messages */}
                {msg.role === 'assistant' && !isLoading && (
                  <div className="ml-1 mt-1.5 flex items-center gap-1">
                    {feedbackGiven[msg.id] ? (
                      <span className="text-xs text-ink-faint">✓ ¡Gracias!</span>
                    ) : (
                      <>
                        <button
                          onClick={() => sendFeedback(
                            msg.id,
                            'up',
                            getPreviousUserMessage(index),
                            getMessageText(msg)
                          )}
                          className="rounded p-1 text-xs text-ink-faint transition-colors hover:bg-accent-soft hover:text-accent"
                          title="Buena respuesta"
                        >
                          👍
                        </button>
                        <button
                          onClick={() => sendFeedback(
                            msg.id,
                            'down',
                            getPreviousUserMessage(index),
                            getMessageText(msg)
                          )}
                          className="rounded p-1 text-xs text-ink-faint transition-colors hover:bg-danger-soft hover:text-danger"
                          title="Mala respuesta"
                        >
                          👎
                        </button>
                      </>
                    )}
                  </div>
                )}
              </div>
            ))}
            {isLoading && (
              <div className="flex justify-start">
                <div className="rounded-lg border border-line bg-surface-muted px-3 py-2 text-sm">
                  <div className="flex space-x-1">
                    <div className="h-1.5 w-1.5 animate-bounce rounded-full bg-ink-faint"></div>
                    <div className="h-1.5 w-1.5 animate-bounce rounded-full bg-ink-faint" style={{ animationDelay: '0.1s' }}></div>
                    <div className="h-1.5 w-1.5 animate-bounce rounded-full bg-ink-faint" style={{ animationDelay: '0.2s' }}></div>
                  </div>
                </div>
              </div>
            )}
            <div ref={messagesEndRef} />
          </div>

          {/* Input */}
          <form onSubmit={handleSubmit} className="border-t border-line bg-surface p-3">
            <div className="flex gap-2">
              <input
                type="text"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyPress={handleKeyPress}
                placeholder="Escribe tu pregunta…"
                className="flex-1 rounded border border-line bg-surface px-3 py-2 text-sm text-ink transition-colors placeholder:text-ink-faint focus:border-accent focus:outline-none disabled:opacity-50"
                disabled={isLoading}
              />
              <button
                type="submit"
                disabled={!input.trim() || isLoading}
                aria-label="Enviar"
                className="rounded border border-accent bg-accent px-4 py-2 text-sm font-medium text-ink-inverse transition-colors hover:bg-accent-dark disabled:opacity-50"
              >
                <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" />
                </svg>
              </button>
            </div>
          </form>
        </div>
      )}
    </>
  );
}
