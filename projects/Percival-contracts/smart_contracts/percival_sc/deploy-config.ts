import "dotenv/config";
import { AlgorandClient } from "@algorandfoundation/algokit-utils";
import { PercivalScFactory } from "../artifacts/percival_sc/PercivalScClient";

// Below is a showcase of various deployment options you can use in TypeScript Client
export async function deploy() {
  console.log("=== Deploying PercivalSc ===");

  const algorand = AlgorandClient.fromEnvironment();

  // Prefer mnemonic (non-local) to avoid KMD; fall back to env/KMD for localnet
  const deployer = process.env.DEPLOYER_MNEMONIC
    ? algorand.account.fromMnemonic(process.env.DEPLOYER_MNEMONIC)
    : await algorand.account.fromEnvironment("DEPLOYER");

  const factory = algorand.client.getTypedAppFactory(PercivalScFactory, {
    defaultSender: deployer.addr,
  });

  const { appClient, result } = await factory.deploy({ onUpdate: "append", onSchemaBreak: "append" });

  // If app was just created fund the app account
  if (["create", "replace"].includes(result.operationPerformed)) {
    await algorand.send.payment({
      amount: (1).algo(),
      sender: deployer.addr,
      receiver: appClient.appAddress,
    });
  }

  const { appId, appAddress, appName } = appClient;

  console.table({
    name: appName,
    id: appId.toString(),
    address: appAddress.toString(),
    deployer: deployer.addr.toString(),
  });
}
