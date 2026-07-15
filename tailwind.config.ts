import type { Config } from "tailwindcss";

const config: Config = {
  darkMode: 'class',
  content: [
    "./pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        // Fondo de la aplicación: crema editorial.
        cream: {
          DEFAULT: '#FAF8F5',
        },
        // Superficies elevadas (cards, tablas, sidebar).
        // Escala de claro a oscuro: surface → cream → surface-hover → surface-muted.
        // `muted` es un paso más oscuro que `cream` para que se lea también sobre
        // el fondo de la app (headers de tabla, paneles, tracks de barras).
        surface: {
          DEFAULT: '#FFFFFF',
          muted: '#F3F0EA',
          hover: '#F5F2EC',
        },
        // Bordes y divisores.
        line: {
          DEFAULT: '#E8E4DD',
          strong: '#D8D3C9',
        },
        // Texto.
        ink: {
          DEFAULT: '#1A1A18',
          muted: '#6B6860',
          faint: '#9A968C',
          inverse: '#FAF8F5',
        },
        // Único acento de la marca: verde oscuro.
        accent: {
          DEFAULT: '#1E4D3B',
          dark: '#163A2C',
          light: '#2A6B52',
          soft: '#ECF1EE',
        },
        // Estados apagados, para badges y alertas.
        warn: {
          DEFAULT: '#8A6A2F',
          soft: '#F7F1E4',
        },
        danger: {
          DEFAULT: '#8C3A32',
          soft: '#F8EDEB',
        },
        // Zonas de entrega: 6 tonos apagados derivados de accent/warn/danger y
        // grises cálidos. Diferencian sin romper la sobriedad; todos son texto
        // oscuro sobre fondo claro. El mapa zona→clase vive en components/ui.
        zone: {
          norte: '#1E4D3B',
          'norte-soft': '#ECF1EE',
          sur: '#4A6046',
          'sur-soft': '#EFF2EE',
          centro: '#8A6A2F',
          'centro-soft': '#F7F1E4',
          oriente: '#8C3A32',
          'oriente-soft': '#F8EDEB',
          occidente: '#6B5340',
          'occidente-soft': '#F4F0EA',
          extramuros: '#6B6860',
          'extramuros-soft': '#F2F0EC',
        },
      },
      fontFamily: {
        serif: ['var(--font-serif)', 'Georgia', 'serif'],
        sans: ['var(--font-sans)', 'system-ui', 'sans-serif'],
      },
      boxShadow: {
        'soft': '0 1px 2px rgba(26, 26, 24, 0.04)',
        'card': '0 1px 2px rgba(26, 26, 24, 0.03)',
        'card-hover': '0 2px 8px rgba(26, 26, 24, 0.06)',
      },
    },
  },
  plugins: [],
};
export default config;
