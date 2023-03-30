import { OpenloginSessionManager } from "@toruslabs/openlogin-session-manager";
import {
  BaseRedirectParams,
  BrowserStorage,
  LoginParams,
  OPENLOGIN_NETWORK,
  OpenLoginOptions,
  OpenloginSessionData,
  OpenloginUserInfo,
  UX_MODE,
} from "@toruslabs/openlogin-utils";
import log from "loglevel";

import PopupHandler from "./PopupHandler";
import { constructURL, getHashQueryParams } from "./utils";

class OpenLogin {
  state: OpenloginSessionData = {};

  private sessionManager: OpenloginSessionManager<OpenloginSessionData>;

  private currentStorage: BrowserStorage;

  private _storageBaseKey = "openlogin_store";

  private options: OpenLoginOptions;

  constructor(options: OpenLoginOptions) {
    if (!options.sdkUrl) {
      if (options.network === OPENLOGIN_NETWORK.MAINNET) {
        options.sdkUrl = "https://app.openlogin.com";
      } else if (options.network === OPENLOGIN_NETWORK.CYAN) {
        options.sdkUrl = "https://cyan.openlogin.com";
      } else if (options.network === OPENLOGIN_NETWORK.TESTNET) {
        options.sdkUrl = "https://beta.openlogin.com";
      } else if (options.network === OPENLOGIN_NETWORK.SK_TESTNET) {
        options.sdkUrl = "https://beta-sk.openlogin.com";
      } else if (options.network === OPENLOGIN_NETWORK.CELESTE) {
        options.sdkUrl = "https://celeste.openlogin.com";
      } else if (options.network === OPENLOGIN_NETWORK.AQUA) {
        options.sdkUrl = "https://aqua.openlogin.com";
      } else if (options.network === OPENLOGIN_NETWORK.DEVELOPMENT) {
        options.sdkUrl = "http://localhost:3000";
      }
    }
    if (!options.sdkUrl) {
      throw new Error("unspecified network and sdkUrl");
    }

    if (!options.redirectUrl) {
      options.redirectUrl = `${window.location.protocol}//${window.location.host}${window.location.pathname}`;
    }

    if (!options.uxMode) options.uxMode = UX_MODE.REDIRECT;
    if (!options.replaceUrlOnRedirect) options.replaceUrlOnRedirect = true;
    if (!options.originData) options.originData = { [window.location.origin]: "" };
    if (!options.whiteLabel) options.whiteLabel = {};
    if (!options.loginConfig) options.loginConfig = {};
    if (!options.storageServerUrl) options.storageServerUrl = "https://broadcast-server.tor.us";
    if (!options.storageKey) options.storageKey = "local";
    if (!options.webauthnTransports) options.webauthnTransports = ["internal"];
    if (!options.sessionTime) options.sessionTime = 86400;

    this.options = options;
  }

  get privKey(): string {
    return this.state.privKey ? this.state.privKey.padStart(64, "0") : "";
  }

  get coreKitKey(): string {
    return this.state.coreKitKey ? this.state.coreKitKey.padStart(64, "0") : "";
  }

  async init(): Promise<void> {
    const storageKey = this.options.sessionNamespace ? `${this._storageBaseKey}_${this.options.sessionNamespace}` : this._storageBaseKey;
    this.currentStorage = BrowserStorage.getInstance(storageKey, this.options.storageKey);

    const sessionId = this.currentStorage.get<string>("sessionId");

    this.sessionManager = new OpenloginSessionManager({
      sessionServerBaseUrl: this.options.storageServerUrl,
      sessionNamespace: this.options.sessionNamespace,
      sessionTime: this.options.sessionTime,
      sessionId,
    });

    if (this.options.network === OPENLOGIN_NETWORK.TESTNET) {
      // using console log because it shouldn't be affected by loglevel config
      // eslint-disable-next-line no-console
      console.log("%c WARNING! You are on testnet. Please set network: 'mainnet' in production", "color: #FF0000");
    }

    const params = getHashQueryParams(this.options.replaceUrlOnRedirect);
    if (params.sessionId) {
      this.currentStorage.set("sessionId", params.sessionId);
      this.sessionManager.sessionKey = params.sessionId;
    }

    if (this.sessionManager.sessionKey) {
      // if this is after redirect, directly sync data.
      const data = await this._authorizeSession();
      // Fill state with correct info from session
      this.updateState(data);
    }
  }

  async login(params: LoginParams & Partial<BaseRedirectParams>): Promise<{ privKey: string }> {
    if (!params || !params.loginProvider) {
      throw new Error(`Please pass loginProvider in params`);
    }

    // in case of redirect mode, redirect url will be dapp specified
    // in case of popup mode, redirect url will be sdk specified
    const defaultParams: BaseRedirectParams = {
      redirectUrl: this.options.redirectUrl,
    };

    const loginParams: LoginParams = {
      loginProvider: params.loginProvider,
      ...defaultParams,
      ...params,
    };
    // do this in popup-window route
    // loginParams.redirectUrl = this.options.uxMode === UX_MODE.POPUP ? `${this.options.sdkUrl}/popup-window` : loginParams.redirectUrl;

    // construct the url to open for either popup/redirect mode and call request method to handle the rest
    const loginId = await this.getLoginId(loginParams);
    if (this.options.uxMode === UX_MODE.REDIRECT) {
      const loginUrl = constructURL({ baseURL: `${this.options.sdkUrl}/start`, hash: { loginId } });
      window.location.href = loginUrl;
      return undefined;
    }
    return new Promise((resolve, reject) => {
      const loginUrl = constructURL({ baseURL: `${this.options.sdkUrl}/popup-window`, hash: { loginId } });
      const currentWindow = new PopupHandler({ url: loginUrl });

      currentWindow.on("close", () => {
        reject(new Error("user closed popup"));
      });

      currentWindow
        .listenOnChannel(loginId)
        .then((sessionId) => {
          this.sessionManager.sessionKey = sessionId;
          return this.sessionManager.authorizeSession();
        })
        .then((sessionData) => {
          this.updateState(sessionData);
          return resolve({ privKey: this.privKey });
        })
        .catch(reject);

      currentWindow.open();
    });
  }

  async logout(): Promise<void> {
    if (!this.sessionManager.sessionKey) throw new Error("User not logged in");
    await this.sessionManager.invalidateSession();
    this.updateState({
      privKey: "",
      coreKitKey: "",
      coreKitEd25519PrivKey: "",
      ed25519PrivKey: "",
      walletKey: "",
      oAuthPrivateKey: "",
      tKey: "",
      userInfo: {
        name: "",
        profileImage: "",
        dappShare: "",
        idToken: "",
        oAuthIdToken: "",
        oAuthAccessToken: "",
        appState: "",
        email: "",
        verifier: "",
        verifierId: "",
        aggregateVerifier: "",
        typeOfLogin: "",
      },
    });

    this.currentStorage.set("sessionId", "");
  }

  async getUserInfo(): Promise<OpenloginUserInfo> {
    if (this.privKey) {
      return this.state.userInfo;
    }
    throw new Error("user should be logged in to fetch userInfo");
  }

  async getLoginId(loginParams: LoginParams & Partial<BaseRedirectParams>): Promise<string> {
    if (!this.sessionManager) throw new Error("session manager not initialized. please call init first");
    const dataObject = {
      options: this.options,
      params: loginParams,
    };

    const loginId = OpenloginSessionManager.generateRandomSessionKey();
    const loginSessionMgr = new OpenloginSessionManager({
      sessionServerBaseUrl: this.options.storageServerUrl,
      sessionNamespace: this.options.sessionNamespace,
      sessionTime: 600, // each login key must be used with 10 mins (might be used at the end of popup redirect)
      sessionId: loginId,
    });

    await loginSessionMgr.createSession(dataObject);

    return loginId;
  }

  private async _authorizeSession(): Promise<OpenloginSessionData> {
    try {
      if (!this.sessionManager.sessionKey) return {};
      const result = await this.sessionManager.authorizeSession();
      return result;
    } catch (err) {
      log.error("authorization failed", err);
      return {};
    }
  }

  private updateState(data: Partial<OpenloginSessionData>) {
    this.state = { ...this.state, ...data };
  }
}

export default OpenLogin;
