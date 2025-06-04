# Changelog

## [1.2.0](https://github.com/nestednotation/nestednotation/compare/v1.1.0...v1.2.0) (2025-06-04)


### Features

* add animation for winning vote, support voting size ([2773535](https://github.com/nestednotation/nestednotation/commit/2773535b9a0b627cb4590bdb0c98db9277d77f3d))
* implement voting logic partially ([#30](https://github.com/nestednotation/nestednotation/issues/30)) ([76d7ebd](https://github.com/nestednotation/nestednotation/commit/76d7ebd104ae9f14a889a28117aaed55778b4c56))
* remove highlight ring logic ([#32](https://github.com/nestednotation/nestednotation/issues/32)) ([811b2b4](https://github.com/nestednotation/nestednotation/commit/811b2b4d47ee6d21a77ab120a434aae0afc89cd1))


### Bug Fixes

* fix bug voting interval did not clear after done voting ([1403aa0](https://github.com/nestednotation/nestednotation/commit/1403aa02a6810f80781f9342b4cc37a2486542e9))
* fix incorrect wspath ([3057ab6](https://github.com/nestednotation/nestednotation/commit/3057ab6339079a8fe76f57a7d9da218903b17689))
* fix stay btn persist ([346292d](https://github.com/nestednotation/nestednotation/commit/346292db4e91ec742504d1009f3c106cccc3d724))
* fix stay btn persist, fix sound restart when continue between frames, minor change to stay btn css ([338fc6e](https://github.com/nestednotation/nestednotation/commit/338fc6efa6c8e89f505e50f632698e55183fa032))
* fix voting indicator remains after voting stopped ([fe5fbcc](https://github.com/nestednotation/nestednotation/commit/fe5fbcc00ad1aeeee67ca0e212bec3832dba026b))
* fix voting size not working when create session ([797f701](https://github.com/nestednotation/nestednotation/commit/797f7017e617daaab846e9f5e31c9143e33ba909))
* hotfix missing navbar ([e927968](https://github.com/nestednotation/nestednotation/commit/e927968a7f86ec2dd0381d2b450ad4ab399f6655))
* incorrect wsPath ([47ed83f](https://github.com/nestednotation/nestednotation/commit/47ed83f8ce6cff300ad67e88f8636d1cecc4e467))
* qr code render incorrect on android ([3bb927b](https://github.com/nestednotation/nestednotation/commit/3bb927b281fa5dadbfeab5b475361cd7956a45b8))
* track voting based on href element ID instead of vote index, fix font error for vote indicator ([f63debb](https://github.com/nestednotation/nestednotation/commit/f63debbcf067bd02478cb4cdafd4669ad9409cef))
* update new guide mode winning animation to smoother one ([bc744c6](https://github.com/nestednotation/nestednotation/commit/bc744c61c9724b953eb196e5e811abfa1b4a8964))

## [1.1.0](https://github.com/nestednotation/nestednotation/compare/v1.0.0...v1.1.0) (2025-03-20)


### Features

* implement about page for score and nested notation ([#24](https://github.com/nestednotation/nestednotation/issues/24)) ([42f32c0](https://github.com/nestednotation/nestednotation/commit/42f32c05d536ba395ada23a74e1a41e8e6ce36cc))
* implement persist state between deployment ([#21](https://github.com/nestednotation/nestednotation/issues/21)) ([b3054ba](https://github.com/nestednotation/nestednotation/commit/b3054ba92161ce3dec1b658862c7187bfb0150ff))
* update UI according to feedback ([#22](https://github.com/nestednotation/nestednotation/issues/22)) ([3c92ea5](https://github.com/nestednotation/nestednotation/commit/3c92ea536a78e4586b7b27b77a7c6b11d5e4471d))


### Bug Fixes

* add cursor pointer to score title, make score title icon open score document, change return to session btn font size ([#26](https://github.com/nestednotation/nestednotation/issues/26)) ([5d40768](https://github.com/nestednotation/nestednotation/commit/5d407684279ead6f915f053fb141d67cb8abf1f6))
* document view not working on iOS, iPadOS ([#25](https://github.com/nestednotation/nestednotation/issues/25)) ([550eb62](https://github.com/nestednotation/nestednotation/commit/550eb6204bbb8e6f481f9f6718bd9181ef80eaaa))
* fix bug sound didn't load when enable autoplay ([32e375c](https://github.com/nestednotation/nestednotation/commit/32e375cadfcd8ccd064daf8257727fa09ee41b50))
* fix UI feedback, allow go to playmode in guidelock, add unmute audio js ([#23](https://github.com/nestednotation/nestednotation/issues/23)) ([e3f6694](https://github.com/nestednotation/nestednotation/commit/e3f669482431ea767babb4d2c30c52aec18930ca))
* missing scroll bar for session manage UI ([ba558d3](https://github.com/nestednotation/nestednotation/commit/ba558d335650498e7d678b08f61a408df0bac790))

## 1.0.0 (2025-02-04)


### Features

* add fade duration and html5 mode toggle to session config ([#4](https://github.com/nestednotation/nestednotation/issues/4)) ([5f6ad33](https://github.com/nestednotation/nestednotation/commit/5f6ad33ab21af12c9edb41f6e1c6570714fa8953))
* add frame transition and chord mode ([#2](https://github.com/nestednotation/nestednotation/issues/2)) ([3b5a9ba](https://github.com/nestednotation/nestednotation/commit/3b5a9ba4830cb9aa698ab4b4ed5a975d24eb127c))
* Implement NODE mode ([#1](https://github.com/nestednotation/nestednotation/issues/1)) ([0c3ca8c](https://github.com/nestednotation/nestednotation/commit/0c3ca8c3beb0780935b07e27325c5bdb0c037e9b))
* update cta into 3-mode button, sound auto continue based on individual sound, optimize to reduce memory usage ([#3](https://github.com/nestednotation/nestednotation/issues/3)) ([d6f6ad7](https://github.com/nestednotation/nestednotation/commit/d6f6ad7396f5543f5aec451fbe50710dd7ef0668))
* update icon for CTA section ([#5](https://github.com/nestednotation/nestednotation/issues/5)) ([b8f7ce7](https://github.com/nestednotation/nestednotation/commit/b8f7ce72b1a1adaa0e14421e7f416860fae324fa))


### Bug Fixes

* variable not found ([0ed18a3](https://github.com/nestednotation/nestednotation/commit/0ed18a3f4c8747345e3c02fc6e7c6d4aea4f36f4))
