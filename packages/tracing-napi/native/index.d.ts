export interface NapiNftResult {
  files: Array<string>
  issues: Array<string>
}

export declare function nodeFileTrace(projectRoot: string, cwd: string, outputBase: string, input: Array<string>, graph: boolean, showIssues: boolean, maxDepth?: number | undefined | null): Promise<NapiNftResult>
export interface NapiTaskMessage {
  taskId: number
  data: Buffer
}

export interface NapiWorkerCreation {
  options: NapiWorkerOptions
}

export interface NapiWorkerOptions {
  filename: RcStr
  cwd: RcStr
}

export interface NapiWorkerTermination {
  options: NapiWorkerOptions
  workerId: number
}

export declare function recvTaskMessageInWorker(workerId: number): Promise<NapiTaskMessage>

export declare function registerWorkerScheduler(creator: (arg: NapiWorkerCreation) => any, terminator: (arg: NapiWorkerTermination) => any): void

export declare function sendTaskMessage(message: NapiTaskMessage): void

export declare function workerCreated(workerId: number): void
