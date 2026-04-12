# `smellgate`

## Overall Idea

I want to build a letterboxd-style app/website where people can log perfumes they have, write a review for perfumes (include ratings for sillage), and also write a description that can be upvoted/downvoted by other people. we want there to be a simple minimalist page where it shows the perfume, lists the creator and the notes (clickable as tags so you can see other perfumes that have those notes or other perfumes by the creator), any existing description by the creator.

So people can click on their own profile, see what they have on their “perfume shelf” (perfumes they own), see what they have reviewed, see what descriptions they’ve written, and people can see eachothers profiles. you can comment on reviews too

## Technical Requirements

Development of this app should rely heavily on unit and integration testing. All CI/CD should be done in GitHub Actions. Ultimately we will want to deploy this on Cloudflare Pages + Workers, but initial development of this should be focused on local deployment, etc.

This will be an app built on ATProto. As such, data storage will occur on users' PDSs, so we will not need a database.

Make HEAVY use of the `gh` CLI. Features should ALWAYS be implemented as PRs to main, all features should be planned as GitHub issues. Always open PRs for new features for issues. ALWAYS assume that multiple coding agents will be working on features simultaneously. Always check the build status of PRs with the `gh` CLI.

## Initial Steps

Everything in this repository is currently a fork of the example `bluesky-social/statusphere-example-app` just to get the initial plumbing up for an app built on ATProto.

## Good To Know

Neither of the people developing this have a deep understanding of typescript/javascript, but collectively have background in programming/deployment/development/perfume. So please challenge suggestions where appropriate.