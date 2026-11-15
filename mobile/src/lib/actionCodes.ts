// Whether the server asks for an extra one-time code before sensitive steps (payout account, co-owner number, account transfer).
// It tells the app in the profile it sends after login: false on the test server, where the login code is the only code ever asked.
let required = true;
export const setActionCodesRequired = (v: boolean) => { required = v; };
export const actionCodesRequired = () => required;
