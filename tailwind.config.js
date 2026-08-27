/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        primary: {
          50: '#eff6ff',
          100: '#dbeafe',
          300: '#93c5fd',
          400: '#60a5fa',
          500: '#3b82f6',
          600: '#2563eb',
          700: '#1d4ed8',
          900: '#1e3a8a',
        },
      },
      borderRadius: {
        control: 'var(--radius-control)',
        toolbar: 'var(--radius-toolbar)',
        panel: 'var(--radius-panel)',
        modal: 'var(--radius-modal)',
      },
      boxShadow: {
        glass: 'var(--glass-shadow)',
        'glass-sm': 'var(--glass-shadow-small)',
      },
      transitionTimingFunction: {
        'ui-out': 'var(--ease-out)',
        'ui-in-out': 'var(--ease-in-out)',
        drawer: 'var(--ease-drawer)',
      },
    },
  },
  plugins: [],
};
