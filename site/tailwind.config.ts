import type { Config } from 'tailwindcss'

const config: Config = {
  content: [
    './index.html',
    './src/**/*.{js,ts,jsx,tsx}',
  ],
  theme: {
    extend: {
      colors: {
        blue: {
          DEFAULT: '#4f8ef7',
          dim: 'rgba(79,142,247,0.12)',
          mid: 'rgba(79,142,247,0.4)',
        },
        surface: {
          DEFAULT: '#08080f',
          2: '#0e0e18',
        },
      },
      fontFamily: {
        mono: ['"JetBrains Mono"', '"Fira Code"', 'monospace'],
        sans: ['Inter', 'system-ui', 'sans-serif'],
      },
      animation: {
        'gradient-shift': 'gradient-shift 4s ease infinite',
        'float': 'float-up 4s ease-in-out infinite',
        'shimmer': 'shimmer-slide 1.5s ease infinite',
        'spin-slow': 'spin 8s linear infinite',
      },
      keyframes: {
        'gradient-shift': {
          '0%': { backgroundPosition: '0% center' },
          '50%': { backgroundPosition: '100% center' },
          '100%': { backgroundPosition: '0% center' },
        },
        'float-up': {
          '0%, 100%': { transform: 'translateY(0)' },
          '50%': { transform: 'translateY(-6px)' },
        },
        'shimmer-slide': {
          '0%': { transform: 'translateX(-100%)' },
          '100%': { transform: 'translateX(100%)' },
        },
      },
    },
  },
  plugins: [],
}

export default config
