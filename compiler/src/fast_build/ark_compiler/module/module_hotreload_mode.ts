/*
 * Copyright (c) 2023 Huawei Device Co., Ltd.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
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

import fs from 'fs';
import path from 'path';

import { ModuleMode } from './module_mode';
import {
  blue,
  reset,
  MODULES_ABC,
  SOURCEMAPS
} from '../common/ark_define';
import { newSourceMaps } from '../transform';
import {
  mkdirsSync,
  toUnixPath,
  validateFilePathLength
} from '../../../utils';

let isFirstBuild: boolean = true;
let hotReloadSourceMap: Object = {};

export class ModuleHotreloadMode extends ModuleMode {
  constructor(rollupObject: any) {
    super(rollupObject);
  }

  generateAbc(rollupObject: any) {
    if (isFirstBuild) {
      this.compileAllFiles(rollupObject);
      isFirstBuild = false;
    } else {
      this.compileChangeListFiles(rollupObject);
    }
  }

  private compileAllFiles(rollupObject: any) {
    this.collectModuleFileList(rollupObject, rollupObject.getModuleIds());
    this.buildModuleSourceMapInfo();
    this.generateAbcByEs2abc();
  }

  private compileChangeListFiles(rollupObject: any) {
    if (!fs.existsSync(this.projectConfig.changedFileList)) {
      this.logger.debug(blue, `ArkTS: Cannot find file: ${
        this.projectConfig.changedFileList}, skip hot reload build`, reset);
      return;
    }

    const changedFileListJson: string = fs.readFileSync(this.projectConfig.changedFileList).toString();
    const changedFileList: Array<string> = JSON.parse(changedFileListJson).modifiedFiles;
    if (typeof changedFileList === 'undefined' || changedFileList.length === 0) {
      this.logger.debug(blue, `ArkTS: No changed files found, skip hot reload build`, reset);
      return;
    }

    if (!fs.existsSync(this.projectConfig.patchAbcPath)) {
      mkdirsSync(this.projectConfig.patchAbcPath);
    }

    this.updateSourceMapFromFileList(changedFileList);
    let changedFileListInAbsolutePath: Array<string> = changedFileList.map((file) => {
      return path.join(this.projectConfig.projectPath, file);
    });
    this.collectModuleFileList(rollupObject, changedFileListInAbsolutePath[Symbol.iterator]());

    const outputABCPath: string = path.join(this.projectConfig.patchAbcPath, MODULES_ABC);
    validateFilePathLength(outputABCPath, this.logger);
    this.moduleAbcPath = outputABCPath;

    this.generateAbcByEs2abc();
  }

  private updateSourceMapFromFileList(fileList: Array<string>) {
    const relativeProjectPath: string = this.projectConfig.projectPath.slice(
      this.projectConfig.projectRootPath.length + path.sep.length);
    for (const file of fileList) {
      const sourceMapPath: string = toUnixPath(path.join(relativeProjectPath, file));
      validateFilePathLength(sourceMapPath, this.logger);
      hotReloadSourceMap[sourceMapPath] = newSourceMaps[sourceMapPath];
    }

    const sourceMapFilePath: string = path.join(this.projectConfig.patchAbcPath, SOURCEMAPS);
    validateFilePathLength(sourceMapFilePath, this.logger);
    fs.writeFileSync(sourceMapFilePath,
      JSON.stringify(hotReloadSourceMap, null, 2), 'utf-8');
  }

  private generateAbcByEs2abc() {
    this.generateEs2AbcCmd();
    this.generateMergedAbcOfEs2Abc();
  }
}
