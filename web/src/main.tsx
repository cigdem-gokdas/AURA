import React from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';

const root = document.getElementById('root');

if (root) {
  createRoot(root).render(
    <React.StrictMode>
      <main>
        <h1>AURA</h1>
        <p>Dashboard scaffold</p>
      </main>
    </React.StrictMode>,
  );
}
