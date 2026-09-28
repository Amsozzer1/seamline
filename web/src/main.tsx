import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Link, Route, Routes } from "react-router-dom";
import { ready } from "./core";
import { OperatorPage } from "./pages/Operator";
import { PanelsPage } from "./pages/Panels";
import { PlanPage } from "./pages/Plan";
import "./styles.css";

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } } });

function App() {
  return (
    <>
      <nav className="topbar">
        <Link to="/" className="brand">
          Seamline
        </Link>
        <span className="muted">weld planning and operator workflow demo</span>
      </nav>
      <Routes>
        <Route path="/" element={<PanelsPage />} />
        <Route path="/revisions/:id" element={<PlanPage />} />
        <Route path="/runs/:id" element={<OperatorPage />} />
        <Route path="*" element={<p className="page">Not found. <Link to="/">Back to panels</Link></p>} />
      </Routes>
    </>
  );
}

// The WASM core must be initialised before anything calls plan() or check().
ready.then(() =>
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <App />
        </BrowserRouter>
      </QueryClientProvider>
    </StrictMode>,
  ),
);
