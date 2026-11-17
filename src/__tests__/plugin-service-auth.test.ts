import {describe,expect,it,vi} from "vitest";
import {readPluginServiceAuth} from "../alwith/codex/pluginServiceAuth";
import type {AppServerClient} from "../alwith/codex/AppServerClient";

function peer() {
    const account = {account:{type:"chatgpt"},workspaceRouting:{backendOrigin:"https://chatgpt.com",chatgptAccountId:"account"}};
    const accountRead = vi.fn().mockResolvedValue(account);
    const getAuthStatus = vi.fn().mockResolvedValue({authMethod:"chatgpt",authToken:"private-test-token"});
    const codex = {accountRead,getAuthStatus} as unknown as AppServerClient;
    return {codex,accountRead,getAuthStatus,account};
}
describe("plugin-service host authentication",()=>{
    it.each([false,true])("reuses login and forwards refreshToken=%s without reading any catalog",async(refresh)=>{
        const {codex,accountRead,getAuthStatus}=peer();
        await expect(readPluginServiceAuth(codex,refresh)).resolves.toEqual({backendOrigin:"https://chatgpt.com",accountId:"account",accessToken:"private-test-token"});
        expect(getAuthStatus).toHaveBeenCalledWith({includeToken:true,refreshToken:refresh});
        expect(accountRead).toHaveBeenCalledTimes(2);
    });
    it("returns null for a non-ChatGPT account without requesting a token",async()=>{
        const {codex,accountRead,getAuthStatus}=peer();
        accountRead.mockResolvedValue({account:{type:"apiKey"},workspaceRouting:null});
        await expect(readPluginServiceAuth(codex,false)).resolves.toBeNull();
        expect(getAuthStatus).not.toHaveBeenCalled();
    });
    it("rejects account changes before returning credentials",async()=>{
        const {codex,accountRead,account}=peer();
        accountRead.mockResolvedValueOnce(account).mockResolvedValueOnce({...account,workspaceRouting:{...account.workspaceRouting,chatgptAccountId:"other"}});
        await expect(readPluginServiceAuth(codex,false)).rejects.toThrow("account changed");
    });
    it("rejects absent routing or credentials",async()=>{
        const {codex,accountRead,getAuthStatus,account}=peer();
        accountRead.mockResolvedValueOnce({...account,workspaceRouting:null});
        await expect(readPluginServiceAuth(codex,false)).rejects.toThrow("routing");
        getAuthStatus.mockResolvedValue({authMethod:"chatgpt",authToken:null});
        await expect(readPluginServiceAuth(codex,false)).rejects.toThrow("credentials");
    });
    it("does not disclose credentials after cancellation",async()=>{
        const {codex,getAuthStatus}=peer();
        const controller=new AbortController();
        getAuthStatus.mockImplementation(async()=>{controller.abort();return {authMethod:"chatgpt",authToken:"private-test-token"};});
        await expect(readPluginServiceAuth(codex,false,controller.signal)).rejects.toThrow();
    });
});
