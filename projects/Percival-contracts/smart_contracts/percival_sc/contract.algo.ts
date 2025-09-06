import { Contract } from '@algorandfoundation/algorand-typescript'

export class PercivalSc extends Contract {
  hello(name: string): string {
    return `Hello, ${name}`
  }
}
