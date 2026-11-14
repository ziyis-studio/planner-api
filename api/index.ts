import { runtimeApi } from "../src/runtime.js";
import { httpHandler } from "../src/http.js";
export default httpHandler(runtimeApi(), true);
