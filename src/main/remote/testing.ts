export const unusedLoopbackPort = (): Promise<number> => Promise.resolve(40000 + Math.floor(Math.random() * 20000))
