import { createRoot } from 'react-dom/client';
import App from './App';
import './styles/index.css';

const root = document.getElementById('root');
if (!root) {
  throw new Error('Root element #root not found');
}

// NOTE: StrictMode is intentionally disabled. React 19's dev double-invoke
// of effects races with WebSocket lifecycle (mount → cleanup → mount) and
// leaves the connection stuck in 'connecting' without ever firing 'open'.
// The signaling hook has a stale-handler guard now, but StrictMode still
// makes dev harder to reason about. Re-enable once stable.
createRoot(root).render(<App />);
