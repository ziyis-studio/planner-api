import { runtimeApi } from "../src/runtime";
import { httpHandler } from "../src/http";
export default httpHandler(runtimeApi(), true);
