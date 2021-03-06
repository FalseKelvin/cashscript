import {
  ContractNode,
  ParameterNode,
  VariableDefinitionNode,
  FunctionDefinitionNode,
  AssignNode,
  IdentifierNode,
  BranchNode,
  CastNode,
  FunctionCallNode,
  UnaryOpNode,
  BinaryOpNode,
  BoolLiteralNode,
  IntLiteralNode,
  HexLiteralNode,
  StringLiteralNode,
  BlockNode,
  TimeOpNode,
  SizeOpNode,
  SplitOpNode,
  ArrayNode,
  TupleIndexOpNode,
  RequireNode,
  SourceFileNode,
  Node,
} from '../ast/AST';
import AstTraversal from '../ast/AstTraversal';
import { GlobalFunction } from '../ast/Globals';
import { resultingType, PrimitiveType } from '../ast/Type';
import {
  Op,
  OpOrData,
  Script,
  toOps,
} from './Script';
import { Data } from '../util';

export default class GenerateTargetTraversal extends AstTraversal {
  output: Script = [];
  stack: string[] = [];

  private scopeDepth = 0;
  private currentFunction: FunctionDefinitionNode;

  private emit(op: OpOrData | OpOrData[]): void {
    if (Array.isArray(op)) {
      this.output.push(...op);
    } else {
      this.output.push(op);
    }
  }

  private pushToStack(value: string, pushToBottom?: boolean): void {
    if (pushToBottom) {
      this.stack.push(value);
    } else {
      this.stack.unshift(value);
    }
  }

  private popFromStack(count: number = 1): void {
    for (let i = 0; i < count; i += 1) {
      this.stack.shift();
    }
  }

  private removeFromStack(i: number): void {
    this.stack.splice(i, 1);
  }

  private nipFromStack(): void {
    this.stack.splice(1, 1);
  }

  private getStackIndex(value: string): number {
    const index = this.stack.indexOf(value);
    if (index === -1) throw new Error(); // Should not happen
    return index;
  }

  visitSourceFile(node: SourceFileNode): Node {
    node.contract = this.visit(node.contract) as ContractNode;

    // Minimally encode output by going Script -> ASM -> Script
    this.output = Data.asmToScript(Data.scriptToAsm(this.output));

    return node;
  }

  visitContract(node: ContractNode): Node {
    node.parameters = this.visitList(node.parameters) as ParameterNode[];
    if (node.functions.length === 1) {
      node.functions = this.visitList(node.functions) as FunctionDefinitionNode[];
    } else {
      this.pushToStack('$$', true);
      node.functions = node.functions.map((f, i) => {
        const stackCopy = [...this.stack];
        const selectorIndex = this.getStackIndex('$$');
        this.emit(Data.encodeInt(selectorIndex));
        if (i === node.functions.length - 1) {
          this.emit(Op.OP_ROLL);
          this.removeFromStack(selectorIndex);
        } else {
          this.emit(Op.OP_PICK);
        }

        this.emit(Data.encodeInt(i));
        this.emit(Op.OP_NUMEQUAL);
        this.emit(Op.OP_IF);
        f = this.visit(f) as FunctionDefinitionNode;

        this.emit(Op.OP_ELSE);
        if (i < node.functions.length - 1) {
          this.stack = [...stackCopy];
        }

        return f;
      });

      this.emit(Op.OP_FALSE);
      node.functions.forEach(() => this.emit(Op.OP_ENDIF));
    }

    return node;
  }

  visitFunctionDefinition(node: FunctionDefinitionNode): Node {
    this.currentFunction = node;
    node.parameters = this.visitList(node.parameters) as ParameterNode[];
    node.body = this.visit(node.body) as BlockNode;

    // Remove final OP_VERIFY
    // If the final opcodes are OP_CHECK{LOCKTIME|SEQUENCE}VERIFY OP_DROP
    //   then push it back to the script, and push OP_TRUE to the stack
    const finalOp = this.output.pop();
    if (finalOp === Op.OP_DROP) {
      this.emit(finalOp);
      this.emit(Op.OP_TRUE);
    }
    this.pushToStack('(value)');
    this.cleanStack();
    return node;
  }

  cleanStack(): void {
    // Keep final verification value, OP_NIP the other stack values
    const stackSize = this.stack.length;
    for (let i = 0; i < stackSize - 1; i += 1) {
      this.emit(Op.OP_NIP);
      this.nipFromStack();
    }
  }

  visitParameter(node: ParameterNode): Node {
    this.pushToStack(node.name, true);
    return node;
  }

  visitVariableDefinition(node: VariableDefinitionNode): Node {
    node.expression = this.visit(node.expression);
    this.popFromStack();
    this.pushToStack(node.name);
    return node;
  }

  visitAssign(node: AssignNode): Node {
    node.expression = this.visit(node.expression);
    if (this.scopeDepth > 0) {
      this.emitReplace(this.getStackIndex(node.identifier.name));
      this.popFromStack();
    } else {
      this.popFromStack();
      this.pushToStack(node.identifier.name);
    }
    return node;
  }

  // This algorithm can be optimised for hardcoded depths
  // See thesis for explanation
  emitReplace(index: number): void {
    this.emit(Data.encodeInt(index));
    this.emit(Op.OP_ROLL);
    this.emit(Op.OP_DROP);
    for (let i = 0; i < index - 1; i += 1) {
      this.emit(Op.OP_SWAP);
      if (i < index - 2) {
        this.emit(Op.OP_TOALTSTACK);
      }
    }
    for (let i = 0; i < index - 2; i += 1) {
      this.emit(Op.OP_FROMALTSTACK);
    }
  }

  visitTimeOp(node: TimeOpNode): Node {
    node.expression = this.visit(node.expression);
    this.emit(toOps.fromTimeOp(node.timeOp));
    this.popFromStack();
    return node;
  }

  visitRequire(node: RequireNode): Node {
    node.expression = this.visit(node.expression);
    this.emit(Op.OP_VERIFY);
    this.popFromStack();
    return node;
  }

  visitBranch(node: BranchNode): Node {
    node.condition = this.visit(node.condition);
    this.popFromStack();

    this.scopeDepth += 1;
    this.emit(Op.OP_IF);

    let stackDepth = this.stack.length;
    node.ifBlock = this.visit(node.ifBlock);
    this.removeScopedVariables(stackDepth);

    if (node.elseBlock) {
      this.emit(Op.OP_ELSE);
      stackDepth = this.stack.length;
      node.elseBlock = this.visit(node.elseBlock);
      this.removeScopedVariables(stackDepth);
    }

    this.emit(Op.OP_ENDIF);
    this.scopeDepth -= 1;

    return node;
  }

  removeScopedVariables(depthBeforeScope: number): void {
    for (let i = 0; i < this.stack.length - depthBeforeScope; i += 1) {
      this.emit(Op.OP_DROP);
      this.popFromStack();
    }
  }

  visitCast(node: CastNode): Node {
    node.expression = this.visit(node.expression);
    this.emit(toOps.fromCast(node.expression.type as PrimitiveType, node.type));
    this.popFromStack();
    this.pushToStack('(value)');
    return node;
  }

  visitFunctionCall(node: FunctionCallNode): Node {
    if (node.identifier.name === GlobalFunction.CHECKMULTISIG) {
      return this.visitMultiSig(node);
    }

    node.parameters = this.visitList(node.parameters);
    this.emit(toOps.fromFunction(node.identifier.name as GlobalFunction));
    this.popFromStack(node.parameters.length);
    this.pushToStack('(value)');

    return node;
  }

  visitMultiSig(node: FunctionCallNode): Node {
    this.emit(Data.encodeBool(false));
    node.parameters = this.visitList(node.parameters);
    this.emit(Op.OP_CHECKMULTISIG);
    const sigs = node.parameters[0] as ArrayNode;
    const pks = node.parameters[1] as ArrayNode;
    this.popFromStack(sigs.elements.length + pks.elements.length + 2);
    this.pushToStack('(value)');

    return node;
  }

  visitTupleIndexOp(node: TupleIndexOpNode): Node {
    node.tuple = this.visit(node.tuple);

    if (node.index === 0) {
      this.emit(Op.OP_DROP);
      this.popFromStack();
    } else if (node.index === 1) {
      this.emit(Op.OP_NIP);
      this.nipFromStack();
    }

    return node;
  }

  visitSizeOp(node: SizeOpNode): Node {
    node.object = this.visit(node.object);
    this.emit(Op.OP_SIZE);
    this.emit(Op.OP_NIP);
    this.popFromStack();
    this.pushToStack('(value)');
    return node;
  }

  visitSplitOp(node: SplitOpNode): Node {
    node.object = this.visit(node.object);
    node.index = this.visit(node.index);
    this.emit(Op.OP_SPLIT);
    this.popFromStack(2);
    this.pushToStack('(value)');
    this.pushToStack('(value)');
    return node;
  }

  visitBinaryOp(node: BinaryOpNode): Node {
    node.left = this.visit(node.left);
    node.right = this.visit(node.right);
    this.emit(toOps.fromBinaryOp(
      node.operator,
      resultingType(node.left.type, node.right.type) === PrimitiveType.INT,
    ));
    this.popFromStack(2);
    this.pushToStack('(value)');
    return node;
  }

  visitUnaryOp(node: UnaryOpNode): Node {
    node.expression = this.visit(node.expression);
    this.emit(toOps.fromUnaryOp(node.operator));
    this.popFromStack();
    this.pushToStack('(value)');
    return node;
  }

  visitArray(node: ArrayNode): Node {
    node.elements = this.visitList(node.elements);
    this.emit(Data.encodeInt(node.elements.length));
    this.pushToStack('(value)');
    return node;
  }

  visitIdentifier(node: IdentifierNode): Node {
    const stackIndex = this.getStackIndex(node.name);
    this.emit(Data.encodeInt(stackIndex));

    // If the final use is inside an if-statement, we still OP_PICK it
    // We do this so that there's no difference in stack depths between execution paths
    if (this.isOpRoll(node)) {
      this.emit(Op.OP_ROLL);
      this.removeFromStack(stackIndex);
    } else {
      this.emit(Op.OP_PICK);
    }

    this.pushToStack('(value)');
    return node;
  }

  isOpRoll(node: IdentifierNode): boolean {
    return this.currentFunction.opRolls.get(node.name) === node && this.scopeDepth === 0;
  }

  visitBoolLiteral(node: BoolLiteralNode): Node {
    this.emit(Data.encodeBool(node.value));
    this.pushToStack('(value)');
    return node;
  }

  visitIntLiteral(node: IntLiteralNode): Node {
    this.emit(Data.encodeInt(node.value));
    this.pushToStack('(value)');
    return node;
  }

  visitStringLiteral(node: StringLiteralNode): Node {
    this.emit(Data.encodeString(node.value));
    this.pushToStack('(value)');
    return node;
  }

  visitHexLiteral(node: HexLiteralNode): Node {
    this.emit(node.value);
    this.pushToStack('(value)');
    return node;
  }
}
