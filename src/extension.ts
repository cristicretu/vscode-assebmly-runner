import * as vscode from "vscode";
import { exec } from "child_process";
import { join } from "path";
import * as fs from "fs";

const diagnosticCollection = vscode.languages.createDiagnosticCollection("asm");

const NASM_COMMAND = "nasm.exe";
const OLLYDBG_COMMAND = "ollydbg.exe";
const ALINK_COMMAND = "ALINK.EXE";

let activeTextEditor = vscode.window.activeTextEditor;
let currentDebugFileExecutable = "";
let stoppingExecutable = false;

const updateConfig = (editor: vscode.TextEditor | null) => {
 const isAsmFile = editor?.document.fileName.endsWith(".asm");
 vscode.workspace
  .getConfiguration()
  .update(
   "asm.showRunIconInEditorTitleMenu",
   isAsmFile,
   vscode.ConfigurationTarget.Workspace
  );
};

const isTerminalVisible = async () => {
 return vscode.workspace.getConfiguration().get("asm.showTerminalInDebugMode");
};

const checkIfBuiltInExtension = (): boolean => {
 const parentDir = join(__dirname, "../../../../../../");
 return (
  fs.existsSync(join(parentDir, "ollydbg")) &&
  fs.existsSync(join(parentDir, "nasm"))
 );
};

const registerCompletionProvider = () => {
 const provider = vscode.languages.registerCompletionItemProvider("asm", {
  provideCompletionItems(
   document: vscode.TextDocument,
   position: vscode.Position
  ) {
   const linePrefix = document
    .lineAt(position)
    .text.substr(0, position.character);
   if (linePrefix.endsWith("bits 32")) {
    const completionItem = new vscode.CompletionItem(
     "bits 32 Template",
     vscode.CompletionItemKind.Snippet
    );
    completionItem.insertText = new vscode.SnippetString(
     `bits 32\nsection .data\n\nsection .bss\n\nsection .text\n\tglobal _start\n\n_start:\n\t; Your code here`
    );
    return [completionItem];
   }
  },
 });
 return provider;
};

export function activate(context: vscode.ExtensionContext) {
 const isBuiltInExtension = checkIfBuiltInExtension();
 updateConfig(activeTextEditor ? activeTextEditor : null);

 const onChangeTextEditor = vscode.window.onDidChangeActiveTextEditor(
  (editor) => {
   activeTextEditor = editor;
   updateConfig(editor ? editor : null);
  }
 );

 const completionProvider = registerCompletionProvider();
 const debug = vscode.commands.registerCommand("asm.debug", debugCommand);
 const run = vscode.commands.registerCommand("asm.run", runCommand);
 const stop = vscode.commands.registerCommand("asm.stop", stopCommand);

 context.subscriptions.push(
  debug,
  run,
  stop,
  onChangeTextEditor,
  completionProvider
 );
}

const getExecutablePath = async (): Promise<string | undefined> => {
 let executablePath: any = vscode.workspace
  .getConfiguration()
  .get("asm.executablePath");
 if (!executablePath) {
  executablePath = await vscode.window.showInputBox({
   placeHolder:
    "Enter the path to the folder containing nasm and ollydbg (asm_tools)",
   value: "",
  });
  if (executablePath) {
   vscode.workspace
    .getConfiguration()
    .update(
     "asm.executablePath",
     executablePath,
     vscode.ConfigurationTarget.Workspace
    );
   vscode.window.showInformationMessage(
    `Saved executable path: ${executablePath}`
   );
  } else {
   vscode.window.showWarningMessage("No executable path set.");
  }
 }
 return executablePath;
};

const stopDebugging = async () => {
 const executableName = "ollydbg.exe";
 stoppingExecutable = true;
 await killExecutable(executableName);
 if (
  currentDebugFileExecutable !== undefined &&
  currentDebugFileExecutable !== ""
 ) {
  await killExecutable(currentDebugFileExecutable!);
 }
 setRunningState(false);
 stoppingExecutable = false;
};

const setRunningState = (isRunning: boolean) => {
 vscode.workspace
  .getConfiguration()
  .update(
   "asm.showStopIconInEditorTitleMenu",
   isRunning,
   vscode.ConfigurationTarget.Global
  );
};

async function killExecutable(executable: string): Promise<string> {
 return new Promise<string>((resolve, reject) => {
  exec("tasklist", (error, stdout) => {
   if (error) {
    console.error(`Error checking for running processes: ${error}`);
    reject(error.message);
   }
   if (stdout.toLowerCase().includes(executable.toLowerCase())) {
    console.log(`The executable ${executable} is running. Stopping it...`);
    exec(`taskkill /F /IM ${executable}`, (error, stdout) => {
     if (error) {
      console.error(`Error stopping ${executable}: ${error}`);
      resolve("error");
     }
     console.log(`${executable} has been successfully stopped.`);
     resolve(stdout);
    });
   } else {
    console.log(`The executable ${executable} is not running.`);
    resolve(stdout);
   }
  });
 });
}

async function startExecutable(executable: string): Promise<string> {
 const documentFileName = activeTextEditor?.document.fileName;
 return new Promise<string>((resolve, reject) => {
  exec(`${executable}`, (error, stdout) => {
   if (error && !stoppingExecutable) {
    console.error(`Error starting ${executable}: ${error}`);

    const splitError = error.message.split("\n");
    if (splitError.length > 1) {
     const pattern = /:(\d+):/;
     const match = splitError[1].match(pattern);

     if (match) {
      const lineNumber = match[1];
      const range = new vscode.Range(
       new vscode.Position(Number(lineNumber) - 1, 0),
       new vscode.Position(Number(lineNumber) - 1, 1000)
      );
      const diagnostic = new vscode.Diagnostic(
       range,
       splitError[1],
       vscode.DiagnosticSeverity.Error
      );
      const diagnostics: vscode.Diagnostic[] = [];
      diagnostics.push(diagnostic);
      diagnosticCollection.set(vscode.Uri.file(documentFileName!), diagnostics);

      console.log("Line Number:", lineNumber);
      vscode.window.showErrorMessage(`Error: ${splitError[1]}`);
     } else {
      console.log("Line number not found in the error message.");
     }

     reject(`Errors: ${splitError[1]}`);
    } else {
     reject(`Error: ${error.message}`);
    }
   }
   console.log(
    `${executable} has been successfully started and terminal minimized.`
   );
   resolve(stdout);
  });
 });
}

async function debugCommand() {
 await stopDebugging();
 var executablePath = await getExecutablePath();
 if (executablePath === undefined || executablePath === "") {
  vscode.window.showInformationMessage("No executable path set!");
  return;
 }
 if (activeTextEditor === undefined) {
  vscode.window.showInformationMessage("No active editor!");
  return;
 }
 const currentFile = activeTextEditor.document.fileName;

 var showTerminal = await isTerminalVisible();

 const lstFile = currentFile.slice(0, -3) + "lst";
 const objFile = currentFile.slice(0, -3) + "obj";
 const exeFile = currentFile.slice(0, -3) + "exe";
 const nasmCommand = `"${executablePath}"\\nasm\\nasm.exe -fobj "${currentFile}" -l "${lstFile}" -I"${executablePath}"\\nasm\\\\`;

 var alinkCommand = "";
 if (showTerminal) {
  alinkCommand = `"${executablePath}\\nasm\\ALINK.EXE" -oPE -subsys console -entry start "${objFile}"`;
 } else {
  alinkCommand = `"${executablePath}\\nasm\\ALINK.EXE" -oPE -entry start "${objFile}"`;
 }
 const ollydbgCommand = `"${executablePath}\\ollydbg\\ollydbg.exe" "${exeFile}"`;

 var fileExecutableName: string | undefined = currentFile.slice(0, -3) + "exe";
 fileExecutableName = fileExecutableName.split("\\").pop();

 currentDebugFileExecutable = fileExecutableName!;

 diagnosticCollection.clear();

 await startExecutable(nasmCommand);
 await startExecutable(alinkCommand);

 setRunningState(true);
 await startExecutable(ollydbgCommand);
 setRunningState(false);

 deleteFile(lstFile);
 deleteFile(objFile);
 deleteFile(exeFile);
}

function deleteFile(fileName: string) {
 const fs = require("fs");
 console.log(`Deleting file ${fileName}`);
 fs.unlink(fileName, (err: any) => {
  if (err) {
   console.error(err);
   return err;
  }
 });
}

// Implement run logic here
async function runCommand() {
 await stopDebugging();
 var executablePath = await getExecutablePath();
 if (executablePath === undefined || executablePath === "") {
  vscode.window.showInformationMessage("No executable path set!");
  return;
 }
 if (activeTextEditor === undefined) {
  vscode.window.showInformationMessage("No active editor!");
  return;
 }
 const currentFile = activeTextEditor.document.fileName;

 const lstFile = currentFile.slice(0, -3) + "lst";
 const objFile = currentFile.slice(0, -3) + "obj";
 const exeFile = currentFile.slice(0, -3) + "exe";

 const nasmCommand = `"${executablePath}"\\nasm\\nasm.exe -fobj "${currentFile}" -l "${lstFile}" -I"${executablePath}"\\nasm\\\\`;
 const alinkCommand = `"${executablePath}\\nasm\\ALINK.EXE" -oPE -subsys console -entry start "${objFile}"`;
 const runCommand = `"${exeFile}"`;

 var fileExecutableName: string | undefined = currentFile.slice(0, -3) + "exe";
 fileExecutableName = fileExecutableName.split("\\").pop();

 diagnosticCollection.clear();
 await startExecutable(nasmCommand);
 await startExecutable(alinkCommand);

 const terminal = vscode.window.createTerminal({
  name: "Assembly",
  hideFromUser: false,
 });
 terminal.show();
 terminal.sendText(runCommand);

 currentDebugFileExecutable = fileExecutableName!;
}

async function stopCommand() {
 await stopDebugging();
}

export function deactivate() {}
