import { render } from "preact";
import "./styles.css";
import { AppState } from "./state";
import { App } from "./ui/App";

const state = new AppState();
render(<App state={state} />, document.getElementById("root")!);
