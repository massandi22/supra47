
// a_auto_login.js
// CLEAN AUTO-LOGIN VERSION — Web3 Challenge (no manual Bearer input)
// Requires: node (>=18), package.json with "type":"module", and dependencies installed:
// npm install axios ethers readline-sync

import axios from "axios";
import { ethers } from "ethers";
import readlineSync from "readline-sync";

// ======= CONFIG =======
// IMPORTANT: fill these values before running
const RPC = "https://bsc.publicnode.com";
const USDT = "0x55d398326f99059fF775485246999027B3197955";
const RELAYER = "0xe1af7daea624ba3b5073f24a6ea5531434d82d88";
const RECIPIENT = "0x0cb634602891d5c200c80052a5047374afce684";

const CAP_KEY = "ISI_API_KEY_CAPMONSTER";               // <--- NEED TO FILL
const SITE_KEY = "ISI_SITEKEY_TURNSTILE";              // <--- NEED TO FILL
const API_BASE = "https://www.b402.ai";
// =======================

function sleep(ms) {
  return new Promise(res => setTimeout(res, ms));
}

// -------------------------------------------------------
// 1. Solve CAPTCHA Turnstile via CapMonster
// -------------------------------------------------------
async function solveCaptcha() {
  if (!CAP_KEY || !SITE_KEY) throw new Error("CAP_KEY or SITE_KEY not set in config.");

  console.log("🔄 Membuat task CapMonster...");

  const createResp = await axios.post(
    "https://api.capmonster.cloud/createTask",
    {
      clientKey: CAP_KEY,
      task: {
        type: "TurnstileTaskProxyless",
        websiteURL: `${API_BASE}/experience-b402`,
        websiteKey: SITE_KEY,
      },
    },
    { timeout: 20000 }
  );

  const taskId = createResp.data?.taskId;
  if (!taskId) throw new Error("No taskId returned from CapMonster createTask.");

  console.log("📝 TaskID:", taskId);

  for (let i = 0; i < 40; i++) {
    await sleep(3000);

    const res = await axios.post(
      "https://api.capmonster.cloud/getTaskResult",
      { clientKey: CAP_KEY, taskId },
      { timeout: 20000 }
    );

    if (res.data?.status === "ready") {
      console.log("✅ Captcha Solved!");
      // CapMonster may return solution object; token can be at different paths
      return res.data.solution?.token || res.data.solution;
    }

    console.log(`⏳ Menunggu captcha... (${i + 1})`);
  }

  throw new Error("Captcha timeout");
}

// -------------------------------------------------------
// 2. LOGIN — Web3 Challenge → Sign → Verify → dapat Bearer
// -------------------------------------------------------
async function autoLogin(wallet) {
  console.log("\n🔐 Login otomatis via Web3 Challenge...");

  const turnstileToken = await solveCaptcha();

  // STEP 1 — ambil challenge
  const ch = await axios.post(`${API_BASE}/api/api/v1/auth/web3/challenge`, {
    walletAddress: wallet.address,
  }, { timeout: 15000 });

  const message = ch.data?.data;
  if (!message) throw new Error("No challenge message from server.");
  console.log("📝 Challenge diterima");

  // STEP 2 — sign challenge
  const signature = await wallet.signMessage(message);

  // STEP 3 — verify → return Bearer
  const verify = await axios.post(
    `${API_BASE}/api/api/v1/auth/web3/verify`,
    {
      walletType: "Wallet",
      walletAddress: wallet.address,
      signature,
      turnstileToken,
    },
    { timeout: 15000 }
  );

  const token = verify.data?.data?.token || verify.data?.token || verify.data;
  if (!token) throw new Error("No token returned from verify.");
  console.log("🎉 Login sukses — Bearer otomatis dibuat!");

  return typeof token === "string" ? token : token.token || JSON.stringify(token);
}

// -------------------------------------------------------
// 3. Approve USDT (jika belum)
// -------------------------------------------------------
async function approveUSDT(wallet) {
  console.log("\n🟦 Cek allowance USDT...");

  const abi = [
    "function allowance(address owner, address spender) view returns (uint256)",
    "function approve(address spender, uint256 value) returns (bool)",
  ];

  const provider = new ethers.JsonRpcProvider(RPC);
  const signer = wallet.connect(provider);
  const token = new ethers.Contract(USDT, abi, signer);

  const allowance = await token.allowance(await signer.getAddress(), RELAYER);

  if (BigInt(allowance) > 0n) {
    console.log("✅ Allowance sudah cukup, skip.");
    return;
  }

  console.log("🔁 Mengirim approve...");
  const tx = await token.approve(RELAYER, ethers.MaxUint256);
  console.log("⏳ TX:", tx.hash);
  await tx.wait();

  console.log("✅ Approve selesai!");
}

// -------------------------------------------------------
// 4. Build 1 payload drip (versi clean)
// -------------------------------------------------------
async function buildPayload(wallet) {
  console.log("\n📦 Membuat payload drip...");

  const now = Math.floor(Date.now() / 1000);

  const domain = {
    name: "B402",
    version: "1",
    chainId: 56,
    verifyingContract: RELAYER,
  };

  const types = {
    TransferWithAuthorization: [
      { name: "token", type: "address" },
      { name: "from", type: "address" },
      { name: "to", type: "address" },
      { name: "value", type: "uint256" },
      { name: "validAfter", type: "uint256" },
      { name: "validBefore", type: "uint256" },
      { name: "nonce", type: "bytes32" },
    ],
  };

  const message = {
    token: USDT,
    from: wallet.address,
    to: RECIPIENT,
    value: ethers.parseUnits("0.1", 18).toString(),
    validAfter: 0,
    validBefore: now + 3600,
    nonce: ethers.hexlify(ethers.randomBytes(32)),
  };

  const signature = await wallet._signTypedData(domain, types, message);

  return {
    recipientAddress: RECIPIENT,
    paymentPayload: {
      token: USDT,
      payload: {
        authorization: message,
        signature,
      },
    },
    paymentRequirements: {
      network: "mainnet",
      relayerContract: RELAYER,
    },
  };
}

// -------------------------------------------------------
// 5. Send Drip Request
// -------------------------------------------------------
async function sendDrip(payload, bearer) {
  console.log("\n🚀 Mengirim drip...");

  const res = await axios.post(
    `${API_BASE}/api/api/v1/faucet/drip`,
    payload,
    { headers: { Authorization: `Bearer ${bearer}` }, timeout: 30000 }
  );

  console.log("🎉 DONE ->", res.data);
  return res.data;
}

// -------------------------------------------------------
// MAIN
// -------------------------------------------------------
(async () => {
  try {
    console.clear();
    console.log("=== AUTO LOGIN CLEAN VERSION ===\n");

    const pk = readlineSync.question("🔐 Private Key: ", { hideEchoBack: true });
    if (!pk) return console.log("0xc0d44e7c437dab5d0d0525741ba5cfe101601dbd9933ded84908f8f5e60d447a");

    const provider = new ethers.JsonRpcProvider(RPC);
    const wallet = new ethers.Wallet(pk, provider);

    const bearer = await autoLogin(wallet);
    await approveUSDT(wallet);

    const payload = await buildPayload(wallet);
    await sendDrip(payload, bearer);

    console.log("\n✅ SELESAI");
  } catch (err) {
    console.error("FATAL:", err.message || err);
  }
})();
