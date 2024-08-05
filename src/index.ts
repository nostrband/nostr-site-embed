// @ts-ignore
import { GlobalNostrSite } from "libnostrsite";

const CORS_PROXY = "https://corsproxy.io/?";

interface Meta {
  title?: string;
  description?: string;
  thumbnail_url?: string;
  author_name?: string;
  icon?: string;
  provider_name?: string;
  oembed_url?: string;
}

async function fetchNoCors(url: string) {
  try {
    return await fetch(url);
  } catch (e) {
    console.log("fetching with corsproxy", url);
    try {
      return await fetch(CORS_PROXY + encodeURIComponent(url));
    } catch (e) {
      console.log("fetching with corsproxy error", url, e);
    }
  }
}

function parseMeta(ns: GlobalNostrSite, url: string, data: string, meta: Meta) {
  const $ = ns.html.loadHtml(data);
  console.log("embed url html", url, $);
  if (!meta.title) meta.title = $("title").text();

  $("meta").each((_: number, m: any) => {
    const name = $(m).attr("name") || $(m).attr("property");
    const value = $(m).attr("content");
    if (!meta.title && name === "og:title") meta.title = value;
    if (!meta.description && name === "description") meta.description = value;
    if (!meta.description && name === "og:description")
      meta.description = value;
    if (!meta.provider_name && name === "og:site_name")
      meta.provider_name = value;
    if (!meta.author_name && name === "author") meta.author_name = value;
    if (!meta.author_name && name === "og:author:username")
      meta.author_name = value;
    if (!meta.thumbnail_url && name === "og:image") meta.thumbnail_url = value;

    // FIXME parse more tags and also schema.org declaration
  });
  $("link").each((_: number, l: any) => {
    if (!meta.icon && $(l).attr("rel").includes("icon")) {
      meta.icon = new URL($(l).attr("href"), url).href;
      return;
    }
    if ($(l).attr("rel") !== "alternate") return;
    if ($(l).attr("type") !== "application/json+oembed") return;
    const href = $(l).attr("href");
    if (!href) return;
    if (!meta.oembed_url) meta.oembed_url = new URL(href, url).href;
  });
}

async function getCachedJson(ns: GlobalNostrSite, id: string) {
  const data = await ns.dbCache.getCache(id);
  console.log("embed cached", id, data);
  if (!data) return undefined;
  try {
    return JSON.parse(data);
  } catch (e) {
    console.log("bad cached oembed data", e, id);
  }
}

async function fetchMeta(ns: GlobalNostrSite, url: string, meta: Meta) {
  const metaCacheId = "embed_meta:" + url;
  const metaCached = await getCachedJson(ns, metaCacheId);
  if (metaCached) {
    // @ts-ignore
    for (const i in metaCached) meta[i] = metaCached[i];
    // got from cache
    return;
  }

  // doesn't throw
  const r = await fetchNoCors(url);

  // helper
  const setDefaults = () => {
    // some defaults from url
    const u = new URL(url);
    if (!meta.icon) meta.icon = u.origin + "/favicon.ico";
    if (!meta.provider_name) meta.provider_name = u.hostname;
  };

  if (r) {
    try {
      // parse html of target page
      parseMeta(ns, url, await r.text(), meta);

      // defaults to empty fields
      setDefaults();

      // write to cache
      await ns.dbCache.putCache(metaCacheId, JSON.stringify(meta));
    } catch (e) {
      console.log("error fetchOembedInfo", e, url);
      // NOTE: we aren't caching failures
    }
  }

  // ensure defaults even if we failed to fetch or parse
  setDefaults();
}

async function fetchOembedInfo(
  ns: GlobalNostrSite,
  url: string,
  maxWidth: number
) {
  // known oembed url (from cache or static list)?
  const cacheId = "embed:" + url;
  let oeUrl = ns.utils.getOembedUrl(url);
  if (!oeUrl) {
    oeUrl = await ns.dbCache.getCache(cacheId);
    if (oeUrl) console.log("embed cached oeUrl", url, oeUrl);
  }

  // get cached meta
  let meta: Meta = {};

  // should we try fetching from html?
  if (!oeUrl) {
    await fetchMeta(ns, url, meta);

    // was there an oembed url in html?
    oeUrl = meta.oembed_url;

    if (oeUrl) {
      console.log("embed url from html", oeUrl);
      await ns.dbCache.putCache(cacheId, oeUrl);
    }
  }

  // finally, do we have the oeUrl?
  if (oeUrl) {
    // fetch oeUrl w/ max width and return the oembed info
    oeUrl += `&maxwidth=${maxWidth}`;

    // cached?
    const dataCacheId = "embed_data:" + oeUrl;
    const dataCached = await getCachedJson(ns, dataCacheId);
    if (dataCached) return dataCached;

    // fetch oembed info
    const r = await fetchNoCors(oeUrl);
    if (r) {
      const data = await r.json();
      if (data.version && (data.provider_name || data.provider_url)) {
        await ns.dbCache.putCache(dataCacheId, JSON.stringify(data));
        // got it!
        return data;
      }

      // fall through to returning meta
      console.log("bad oembed reply", data);
    }
  }

  // if we didn't take oeUrl from html and meta is
  // empty - load it, bcs we failed to get data from oeUrl
  if (!meta.provider_name) await fetchMeta(ns, url, meta);

  // as a fallback for failed oembed
  // return meta info from html
  return meta;
}

async function process(ns: GlobalNostrSite, e: Element) {
  const url = e.getAttribute("url");
  const id = e.getAttribute("nostr");

  console.log("embed", { id, url });
  if (id) {
    // const event = await ns.utils.fetchEvent(ns.ndk, {
    //   // filter
    // }, relays, 1000)
    // FIXME fetch the target event
    return;
  }

  if (url) {
    // NOTE: to get proper oembed we need to figure out the available
    // width, to do that we add a 'width: 100%' element and get it's
    // dimentions. since we're gonna need an iframe for the oembed
    // we'll use it as the width-getter element,
    // srcdoc is needed to trigger onload,
    // and to show the loading spinner
    // NOTE: while loading, we still show the original link so let
    // users click on it if embed is slow
    const urlId = ""+Math.random();
    const code = `<span data-oembed-id="${urlId}">${e.innerHTML}</span>
        <iframe
          frameborder="0"
          allow="geolocation 'none'"
          allowfullscreen="true"
          referrerpolicy="no-referrer"
          sandbox="allow-scripts allow-same-origin allow-presentation allow-popups allow-popups-to-escape-sandbox"
          style="width: 100%; border-radius: 5px;"
          data-oembed-id="${urlId}"
          scrolling="no"
        ></iframe>`;

    // replace the contents
    e.innerHTML = code;

    // now get the ref to an iframe we've created
    const iframe: HTMLIFrameElement | null = document.querySelector(
      `iframe[data-oembed-id="${urlId}"]`
    );
    if (!iframe) throw new Error("Failed to inject oembed iframe");

    // set spinner doc to show loading state and to make sure 'load' event is fired
    iframe.setAttribute(
      "srcdoc",
      `
      <html>
        <body style='opacity: 0.5'><!-- works good on both dark and light themes -->
          <section id="container">
            <div class="loader"></div>
          </section>
          <style>
            #container {
              position: absolute;
              top: 0;
              left: 0;
              height: 100%;
              width: 100%;
              background-color: #fff;
              z-index: 1000000;
              display: block;
            }
        
            #container .loader {
              opacity: 1;
              width: 48px;
              height: 48px;
              margin: -24px 0 0 -24px;
              border: 5px solid #bbb;
              border-bottom-color: transparent;
              border-radius: 50%;
              display: inline-block;
              box-sizing: border-box;
              animation: rotation 1s linear infinite;
              position: absolute;
              top: 50%;
              left: 50%;
            }
        
            @keyframes rotation {
              0% {
                transform: rotate(0deg);
              }
        
              100% {
                transform: rotate(360deg);
              }
            }
          </style>
        </body>
      </html>
    `
    );

    // wait until it's rendered to get the width
    iframe.onload = async () => {
      const pageWidth = iframe.contentDocument!.documentElement.scrollWidth;
      console.log("embed iframe created, width", pageWidth);

      const oe = await fetchOembedInfo(ns, url, pageWidth);
      console.log("embed oe info new", url, oe);
      if (!oe) {
        // no longer needed
        iframe.remove();
        return;
      }

      if (!oe.html) {
        // we won't be injecting third-party code here
        iframe.remove();

        // FIXME use some hbs template provided by ns

        // just a preview w/ title, desc and image
        // if it's video, add a 'play' overlay
        const u = new URL(url);
        const data = {
          ...oe,
          embed_url: url,
          is_video: oe.type === "video",
          icon_nocors: oe.icon ? CORS_PROXY + encodeURIComponent(oe.icon) : "",
          url_path: u.pathname + u.search,
          only_path: !oe.title && !oe.description,
          show_thumbnail: oe.thumbnail_url && (oe.title || oe.description),
          thumbnail_url_nocors: oe.thumbnail_url
            ? CORS_PROXY + encodeURIComponent(oe.thumbnail_url)
            : undefined,
        };

        const code = await ns.renderer.renderPartial("embed-url", data, {});
        console.log("embed url rendered", data, code);

        // const maxHeight = 200;
        // const code = `<style>
        //   .np-embed-figure-thumbnail {
        //     width: 40%;
        //   }
        //   .np-embed-figure-thumbnail img {
        //     height: 100%;
        //     min-height: ${maxHeight}px;
        //     border-top-right-radius: 5px;
        //     border-bottom-right-radius: 5px;
        //   }
        //   @media screen and (max-width: 600px) {
        //     .np-embed-figure a {
        //       flex-direction: column-reverse;
        //     }
        //     .np-embed-figure-thumbnail {
        //       width: 100%;
        //     }
        //     .np-embed-figure-thumbnail img {
        //       width: 100%;
        //       height: auto;
        //       max-height: ${maxHeight * 2}px;
        //       border-top-right-radius: 5px;
        //       border-top-left-radius: 5px;
        //       border-bottom-right-radius: 0;
        //     }
        //   }
        // </style><figure class='np-embed-figure'><a href="${url}" target="_blank"
        //   class='${oe.type === "video" ? "np-oembed-video-link" : ""}'
        //   style='display: flex; gap: 10px; justify-content: space-between; padding: 0; margin: 10px 0; border: 1px solid #bbb; border-radius: 5px; text-decoration: none'
        // >
        // <div style='display: flex; flex-direction: column; flex: 5; padding: 20px; width: 100%'>
        //   <div style='text-decoration: underline; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;'>${
        //     oe.title || ""
        //   }</div>
        //   <div style='flex: 5; text-decoration: none; font-size: smaller; display: -webkit-box; -webkit-line-clamp: 4; -webkit-box-orient: vertical; overflow: hidden;'>${
        //     oe.description || ""
        //   }</div>
        //   <div style='display: flex; gap: 10px; justify-content: flex-start; align-items: center'>
        //     ${
        //       oe.icon
        //         ? `<img src='${oe.icon}' onerror="this.src='${
        //             CORS_PROXY + encodeURIComponent(oe.icon)
        //           }'; this.onerror=() => { this.style.display='none' }" style='width: 24px; height: 24px; border-radius: 3px'>`
        //         : ""
        //     }
        //     <div style='font-size: smaller'>${oe.provider_name}${
        //   oe.author_name ? ` • ${oe.author_name}` : ""
        // }</div>
        //     ${
        //       !oe.title && !oe.description
        //         ? `<div style='flex: 5; font-size: smaller; opacity: 0.7; overflow: hidden; white-space: nowrap; text-overflow: ellipsis'>${
        //             u.pathname + u.search
        //           }</div>`
        //         : ""
        //     }
        //   </div>
        // </div>
        // ${
        //   oe.thumbnail_url && (oe.title || oe.description)
        //     ? `<div class='np-embed-figure-thumbnail'><img src="${
        //         oe.thumbnail_url
        //       }"
        //         style='object-fit: cover; object-position: left top; '
        //         onerror="this.src='${
        //           CORS_PROXY + encodeURIComponent(oe.thumbnail_url)
        //         }'; this.onerror=() => { this.parentElement.style.display='none' }"/></div>`
        //     : ""
        // }
        // </a></figure>`;
        e.innerHTML = code;
        return;
      }

      // set srcdoc to a sandboxed same-origin iframe
      // that will watch it's content and adjust it's size
      // to the size of content
      // NOTE: not clear if adding this additional iframe actually
      // delivers any more safety than embedding the oembed html
      // directly... well at least we have _some_ control over it,
      // need to learn more about ways to sandbox it better
      iframe.setAttribute(
        "srcdoc",
        `<!DOCTYPE html>
          <html>
            <head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/></head>
            <body style='margin: 0; padding: 0'>
              ${oe.html}
            </body>
          </html>`
      );
      // reset
      iframe.style.borderRadius = "0";

      let wasHeight = 0;
      function updateIframeSize() {
        if (!iframe) return;

        // what's the size of embedded document?
        // const contentWidth =
        //   iframe.contentDocument!.documentElement.scrollWidth;
        let contentHeight =
          iframe.contentDocument!.documentElement.scrollHeight;
        // console.log("embed iframe loaded size", contentWidth, contentHeight);

        const oeIframe = iframe.contentDocument!.querySelector("iframe");
        // console.log("embed oeIframe", oeIframe);
        if (oeIframe) {
          // adjust size of the embedded iframe,
          // mainly for small youtube embeds
          let w =
            oeIframe.offsetWidth || oeIframe.getAttribute("width") || oe.width;
          let h =
            oeIframe.offsetHeight ||
            oeIframe.getAttribute("height") ||
            oe.height;
          // console.log("embed content iframe size", w, h, wasHeight);
          if (w && h) {
            const d = pageWidth / w;
            w = Math.round(w * d);
            h = Math.round(h * d);
            if (Math.abs(wasHeight - h) > 2) {
              wasHeight = h;
              console.log("embed adjusted height", w, h);

              // adjust the target height and width
              oeIframe.setAttribute("width", w);
              oeIframe.setAttribute("height", h);

              // make sure container height is increased too, with small margin
              if (contentHeight < h) contentHeight = h + 10;
            }
          }
        }

        // update height based on the height of embedded content
        iframe.setAttribute("height", "" + contentHeight);
      }

      // change onload handler to proceed when
      // srcdoc has been processed and all embeds were loaded
      iframe.onload = () => {
        // drop the original link, we've got the oembed loaded!
        const source = document.querySelector(
          `span[data-oembed-id="${urlId}"]`
        );
        if (source) source.remove();

        updateIframeSize();
        setInterval(updateIframeSize, 300);
      };
    };
  }
}

async function init() {
  // @ts-ignore
  console.log("embeds init", window.nostrSite);
  // @ts-ignore
  if (!window.nostrSite) {
    console.log("embeds waiting for npLoad");
    await new Promise<Event>((ok) => document.addEventListener("npLoad", ok));
  }

  console.log("embeds starting");

  // @ts-ignore
  const ns: GlobalNostrSite = window.nostrSite;
  await ns.tabReady;

  console.log("embeds tab ready");
  const embeds = document.querySelectorAll("np-embed");
  for (const el of embeds) {
    try {
      await process(ns, el);
    } catch (e) {
      console.log("failed to embed", e, el);
    }
  }
}

console.log("embeds readyState", document.readyState);
if (document.readyState === "loading")
  document.addEventListener("DOMContentLoaded", init);
else init();
