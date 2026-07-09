import ReactDOM from "react-dom/client";
import App from "./App";

// 注意：不使用 StrictMode——其开发期双挂载会导致 PTY/SSH 会话被重复创建又销毁
ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(<App />);
