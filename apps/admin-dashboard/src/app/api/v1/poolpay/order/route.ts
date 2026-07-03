// Back-compat alias. The canonical S2S endpoint is /api/v1/katana-pay/order.
// Kept so any existing integration on the old path keeps working.
export { POST, dynamic } from "../../katana-pay/order/route";
