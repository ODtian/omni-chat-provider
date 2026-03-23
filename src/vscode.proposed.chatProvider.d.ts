/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

declare module "vscode" {
	/**
	 * The provider version of {@linkcode LanguageModelChatRequestOptions}
	 */
	export interface ProvideLanguageModelChatResponseOptions {
		/**
		 * What extension initiated the request to the language model, or
		 * `undefined` if the request was initiated by other functionality in the editor.
		 */
		readonly requestInitiator: string;

		/**
		 * Per-model configuration provided by the user.
		 */
		readonly modelConfiguration?: {
			readonly [key: string]: any;
		};
	}

	/**
	 * All the information representing a single language model contributed by a {@linkcode LanguageModelChatProvider}.
	 */
	export interface LanguageModelChatInformation {
		readonly requiresAuthorization?: true | { label: string };
		readonly multiplier?: string;
		readonly multiplierNumeric?: number;
		readonly isDefault?: boolean | { [K in ChatLocation]?: boolean };
		readonly isUserSelectable?: boolean;
		readonly category?: { label: string; order: number };
		readonly statusIcon?: ThemeIcon;
		readonly configurationSchema?: LanguageModelConfigurationSchema;
		readonly targetChatSessionType?: string;
		readonly contextWindow?: number;
		readonly contextLength?: number;
	}

	export interface LanguageModelChatCapabilities {
		readonly editTools?: string[];
	}

	export type LanguageModelResponsePart2 = LanguageModelResponsePart | LanguageModelDataPart | LanguageModelThinkingPart;

	export type LanguageModelConfigurationSchema = {
		readonly properties?: {
			readonly [key: string]: Record<string, any> & {
				readonly enumItemLabels?: string[];
				readonly group?: string;
			};
		};
	};

	export interface LanguageModelChatProvider<T extends LanguageModelChatInformation = LanguageModelChatInformation> {
		provideLanguageModelChatInformation(options: PrepareLanguageModelChatModelOptions, token: CancellationToken): ProviderResult<T[]>;
		provideLanguageModelChatResponse(model: T, messages: readonly LanguageModelChatRequestMessage[], options: ProvideLanguageModelChatResponseOptions, progress: Progress<LanguageModelResponsePart2>, token: CancellationToken): Thenable<void>;
	}

	/**
	 * The list of options passed into {@linkcode LanguageModelChatProvider.provideLanguageModelChatInformation}
	 */
	export interface PrepareLanguageModelChatModelOptions {
		readonly configuration?: {
			readonly [key: string]: any;
		};
	}

	export interface ChatRequest {
		readonly modelConfiguration?: { readonly [key: string]: any };
	}
}