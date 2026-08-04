export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        canvas: '#0B0D0F',
        chrome: '#101316',
        surface: {
          DEFAULT: '#15191D',
          raised: '#1B2025',
        },
        well: '#090B0D',
        border: {
          DEFAULT: '#2D343B',
          strong: '#46505A',
        },
        paper: {
          DEFAULT: '#F0EDE6',
          muted: '#A7A9A7',
          subtle: '#777D82',
        },
        gold: {
          DEFAULT: '#D2A35A',
          hover: '#E0B36D',
        },
        success: '#7FA28A',
        danger: '#C97269',
      },
      fontFamily: {
        sans: ['Archivo', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        mono: ['"IBM Plex Mono"', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      boxShadow: {
        archive: '0 24px 64px rgba(0,0,0,.38)',
      },
    },
  },
  plugins: [],
}
