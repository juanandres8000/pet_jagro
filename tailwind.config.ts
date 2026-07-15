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
          deep: '#F3F0EA',
        },
        // Superficies elevadas (cards, tablas, sidebar).
        surface: {
          DEFAULT: '#FFFFFF',
          muted: '#FAF8F5',
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
