// Keep Node-compatible Upgrade and rejected-handshake handling on the loopback connection.
declare module "ws-transport" {
    export {default, WebSocketServer, type RawData} from "ws";
}
