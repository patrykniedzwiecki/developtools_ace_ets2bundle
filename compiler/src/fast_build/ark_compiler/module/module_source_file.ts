/*
 * Copyright (c) 2023 Huawei Device Co., Ltd.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use rollupObject file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import * as ts from 'typescript';
import path from 'path';
import MagicString from 'magic-string';
import merge from 'merge-source-map';
import {
  GEN_ABC_PLUGIN_NAME,
  PACKAGES
} from '../common/ark_define';
import {
  getOhmUrlByFilepath,
  getOhmUrlByHarName,
  getOhmUrlBySystemApiOrLibRequest
} from '../../../ark_utils';
import { writeFileSyncByNode } from '../../../process_module_files';
import {
  isJsonSourceFile,
  isJsSourceFile,
  writeFileContentToTempDir
} from '../utils';
import { toUnixPath } from '../../../utils';
import { newSourceMaps } from '../transform';

const ROLLUP_IMPORT_NODE: string = 'ImportDeclaration';
const ROLLUP_EXPORTNAME_NODE: string = 'ExportNamedDeclaration';
const ROLLUP_EXPORTALL_NODE: string = 'ExportAllDeclaration';
const ROLLUP_DYNAMICIMPORT_NODE: string = 'ImportExpression';
const ROLLUP_LITERAL_NODE: string = 'Literal';

export class ModuleSourceFile {
  private static sourceFiles: ModuleSourceFile[] = [];
  private moduleId: string;
  private source: string | ts.SourceFile;
  private isSourceNode: boolean = false;
  private static projectConfig: any;
  private static logger: any;

  constructor(moduleId: string, source: string | ts.SourceFile) {
    this.moduleId = moduleId;
    this.source = source;
    if (typeof this.source !== 'string') {
      this.isSourceNode = true;
    }
  }

  static newSourceFile(moduleId: string, source: string | ts.SourceFile) {
    ModuleSourceFile.sourceFiles.push(new ModuleSourceFile(moduleId, source));
  }

  static async processModuleSourceFiles(rollupObject: any) {
    this.initPluginEnv(rollupObject);
    for (const source of ModuleSourceFile.sourceFiles) {
      if (!rollupObject.share.projectConfig.compileHar) {
        // compileHar: compile closed source har of project, which convert .ets to .d.ts and js, doesn't transform module request.
        source.processModuleRequest(rollupObject);
      }
      await source.writeSourceFile();
    }
    ModuleSourceFile.sourceFiles = [];
  }

  private async writeSourceFile() {
    if (this.isSourceNode && !isJsSourceFile(this.moduleId)) {
      writeFileSyncByNode(<ts.SourceFile>this.source, true, ModuleSourceFile.projectConfig);
    } else {
      await writeFileContentToTempDir(this.moduleId, <string>this.source, ModuleSourceFile.projectConfig,
        ModuleSourceFile.logger);
    }
  }

  private getOhmUrl(rollupObject: any, moduleRequest: string, filePath: string | undefined): string | undefined {
    let systemOrLibOhmUrl: string | undefined = getOhmUrlBySystemApiOrLibRequest(moduleRequest);
    if (systemOrLibOhmUrl != undefined) {
      return systemOrLibOhmUrl;
    }
    const harOhmUrl: string | undefined = getOhmUrlByHarName(moduleRequest, ModuleSourceFile.projectConfig);
    if (harOhmUrl !== undefined) {
      return harOhmUrl;
    }
    if (filePath) {
      const targetModuleInfo: any = rollupObject.getModuleInfo(filePath);
      const namespace: string = targetModuleInfo['meta']['moduleName'];
      const ohmUrl: string =
        getOhmUrlByFilepath(filePath, ModuleSourceFile.projectConfig, ModuleSourceFile.logger, namespace);
      return ohmUrl.startsWith(PACKAGES) ? `@package:${ohmUrl}` : `@bundle:${ohmUrl}`;
    }
    return undefined;
  }

  private processJsModuleRequest(rollupObject: any) {
    const moduleInfo: any = rollupObject.getModuleInfo(this.moduleId);
    const importMap: any = moduleInfo.importedIdMaps;
    const REG_DEPENDENCY: RegExp = /(?:import|from)(?:\s*)['"]([^'"]+)['"]|(?:import)(?:\s*)\(['"]([^'"]+)['"]\)/g;
    this.source = (<string>this.source).replace(REG_DEPENDENCY, (item, staticModuleRequest, dynamicModuleRequest) => {
      const moduleRequest: string = staticModuleRequest || dynamicModuleRequest;
      const ohmUrl: string | undefined = this.getOhmUrl(rollupObject, moduleRequest, importMap[moduleRequest]);
      if (ohmUrl !== undefined) {
        item = item.replace(/(['"])(?:\S+)['"]/, (_, quotation) => {
          return quotation + ohmUrl + quotation;
        });
      }
      return item;
    });
  }

  private processTransformedJsModuleRequest(rollupObject: any) {
    const moduleInfo: any = rollupObject.getModuleInfo(this.moduleId);
    const importMap: any = moduleInfo.importedIdMaps;
    const code: MagicString = new MagicString(<string>this.source);
    const ast = moduleInfo.ast;
    const moduleNodeMap: Map<string, any> =
      moduleInfo.getNodeByType(ROLLUP_IMPORT_NODE, ROLLUP_EXPORTNAME_NODE, ROLLUP_EXPORTALL_NODE,
        ROLLUP_DYNAMICIMPORT_NODE);

    for (let nodeSet of moduleNodeMap.values()) {
      nodeSet.forEach(node => {
        if (node.source && node.source.type === ROLLUP_LITERAL_NODE) {
          const ohmUrl: string | undefined =
            this.getOhmUrl(rollupObject, node.source.value, importMap[node.source.value]);
          if (ohmUrl !== undefined) {
            code.update(node.source.start, node.source.end, `'${ohmUrl}'`);
          }
        }
      });
    }

    // update sourceMap
    const relativeSourceFilePath =
      toUnixPath(this.moduleId.replace(ModuleSourceFile.projectConfig.projectRootPath + path.sep, ''));
    const updatedMap = code.generateMap({
      source: relativeSourceFilePath,
      file: `${path.basename(this.moduleId)}`,
      includeContent: false,
      hires: true
    });
    newSourceMaps[relativeSourceFilePath] = merge(newSourceMaps[relativeSourceFilePath], updatedMap);

    this.source = code.toString();
  }

  private processTransformedTsModuleRequest(rollupObject: any) {
    const moduleInfo: any = rollupObject.getModuleInfo(this.moduleId);
    const importMap: any = moduleInfo.importedIdMaps;

    const moduleNodeTransformer: ts.TransformerFactory<ts.SourceFile> = context => {
      const visitor: ts.Visitor = node => {
        node = ts.visitEachChild(node, visitor, context);
        // staticImport node
        if (ts.isImportDeclaration(node) || (ts.isExportDeclaration(node) && node.moduleSpecifier)) {
          // moduleSpecifier.getText() returns string carrying on quotation marks which the importMap's key does not,
          // so we need to remove the quotation marks from moduleRequest.
          const moduleRequest: string = node.moduleSpecifier.getText().replace(/'|"/g, '');
          const ohmUrl: string | undefined = this.getOhmUrl(rollupObject, moduleRequest, importMap[moduleRequest]);
          if (ohmUrl !== undefined) {
            if (ts.isImportDeclaration(node)) {
              return ts.factory.createImportDeclaration(node.decorators, node.modifiers,
                node.importClause, ts.factory.createStringLiteral(ohmUrl));
            } else {
              return ts.factory.createExportDeclaration(node.decorators, node.modifiers,
                node.isTypeOnly, node.exportClause, ts.factory.createStringLiteral(ohmUrl));
            }
          }
        }
        // dynamicImport node
        if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword &&
          ts.isStringLiteral(node.arguments[0])) {
          const moduleRequest: string = node.arguments[0].getText().replace(/'|"/g, '');
          const ohmUrl: string | undefined = this.getOhmUrl(rollupObject, moduleRequest, importMap[moduleRequest]);
          const args: ts.Expression[] = [...node.arguments];
          args[0] = ts.factory.createStringLiteral(ohmUrl);
          return ts.factory.createCallExpression(node.expression, node.typeArguments, args);
        }
        return node;
      };
      return node => ts.visitNode(node, visitor);
    };

    const result: ts.TransformationResult<ts.SourceFile> =
      ts.transform(<ts.SourceFile>this.source!, [moduleNodeTransformer]);

    this.source = result.transformed[0];
  }

  // Replace each module request in source file to a unique representation which is called 'ohmUrl'.
  // This 'ohmUrl' will be the same as the record name for each file, to make sure runtime can find the corresponding
  // record based on each module request.
  processModuleRequest(rollupObject: any) {
    if (isJsonSourceFile(this.moduleId)) {
      return;
    }
    if (isJsSourceFile(this.moduleId)) {
      this.processJsModuleRequest(rollupObject);
      return;
    }

    // Only when files were transformed to ts, the corresponding ModuleSourceFile were initialized with sourceFile node,
    // if files were transformed to js, ModuleSourceFile were initialized with srouce string.
    this.isSourceNode ? this.processTransformedTsModuleRequest(rollupObject) :
      this.processTransformedJsModuleRequest(rollupObject);
  }

  private static initPluginEnv(rollupObject: any) {
    this.projectConfig = Object.assign(rollupObject.share.arkProjectConfig, rollupObject.share.projectConfig);
    this.logger = rollupObject.share.getLogger(GEN_ABC_PLUGIN_NAME);
  }
}
