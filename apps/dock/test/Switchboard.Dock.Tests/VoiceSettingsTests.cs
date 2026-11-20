using System.Text.Json.Nodes;
using Avalonia.Controls;
using Avalonia.Headless.XUnit;
using Avalonia.Interactivity;
using Avalonia.Threading;
using Avalonia.VisualTree;
using Switchboard.Dock.Settings;
using Switchboard.Dock.Views;

namespace Switchboard.Dock.Tests;

/// <summary>The Settings window's Voice page and persona pages (PRD R105, R106).</summary>
public sealed class VoiceSettingsTests
{
    readonly FakeConfigHub hub = new();

    /// <summary>Settings whose voice section has two personas, nova and orion, and gives dev:review to nova.</summary>
    static JsonObject WithRoster() =>
        SettingsConfigs.Basic().Also((config) => SettingsConfigs.Value(config)["voice"] = new JsonObject
        {
            ["enabled"] = true,
            ["personas"] = new JsonArray(
                new JsonObject { ["id"] = "nova", ["name"] = "Nova", ["voice"] = "cedar" },
                new JsonObject { ["id"] = "orion", ["name"] = "Orion" }),
            ["playbookPersonas"] = new JsonObject { ["dev:review"] = "nova" },
        });

    static EditorState State(JsonObject? config = null) => SettingsConfigs.State(config ?? WithRoster());

    async Task<SettingsEditor> Loaded(JsonObject? config = null)
    {
        hub.Config = config ?? WithRoster();

        var editor = new SettingsEditor(hub, (cancel) => Task.Delay(Timeout.Infinite, cancel));

        await editor.Load();
        hub.Calls.Clear();

        return editor;
    }

    static Field FieldOf(IReadOnlyList<Section> sections, string path) => sections.SelectMany((section) => section.Fields).Single((field) => field.Path == path);

    [Fact]
    public void Nav_Roster_ListsVoiceAfterGeneralAndEachPersonaUnderPersonas()
    {
        var state = State();

        state.SetDraft(SettingsFields.SetAt(state.SettingsValue!, "voice.personas[1].name", "Orion Two"));
        state.Errors = ["voice.personas[0].name must be 1 to 40 characters."];

        var nav = SettingsPages.Nav(state);

        Assert.Equal(
            ["heading Settings", "item General", "item Voice", "heading Personas", "item Nova", "item Orion Two", "add New persona", "heading Sources"],
            nav.Take(8).Select((entry) => $"{entry.Kind} {entry.Label}"));
        Assert.Equal(("persona:0", false, true), (nav[4].Argument, nav[4].Dirty, nav[4].HasErrors));
        Assert.Equal(("persona:1", true, false), (nav[5].Argument, nav[5].Dirty, nav[5].HasErrors));
        Assert.False(nav[2].Dirty);
    }

    [Fact]
    public void VoiceFields_AnyState_OffersTheSpeechSettingsWithTheirDefaults()
    {
        var sections = SettingsFields.VoiceFields(SettingsConfigs.State());

        Assert.Equal(["Speech", "Dictation", "Playbook personas"], sections.Select((section) => section.Heading));
        Assert.Equal(
            ["voice.enabled", "voice.voice", "voice.style", "voice.speed", "voice.expressive", "voice.expandReplies", "voice.awayMinutes", "voice.needsYouSound", "voice.outputDevice"],
            sections[0].Fields.Select((field) => field.Path));
        Assert.Equal(["voice.micIdleMinutes", "voice.endPauseMs", "voice.inputDevice"], sections[1].Fields.Select((field) => field.Path));
        Assert.Empty(sections[2].Fields);

        var fields = sections[0].Fields.ToDictionary((field) => field.Path);

        Assert.False(SettingsPages.FieldViewOf(fields["voice.enabled"], null, []).Checked);
        Assert.True(SettingsPages.FieldViewOf(fields["voice.needsYouSound"], null, []).Checked);
        Assert.Equal("marin", SettingsPages.FieldViewOf(fields["voice.voice"], null, []).Selected);
        Assert.Equal(SettingsFields.TtsVoices, fields["voice.voice"].Options!.Select((option) => option.Value));
        Assert.Equal(["None", "Pair", "Upbeat", "Deadpan", "Expressive"], fields["voice.style"].Options!.Select((option) => option.Label));
        Assert.Equal((FieldKind.Number, "1"), (fields["voice.speed"].Kind, fields["voice.speed"].Placeholder));
        Assert.Equal((FieldKind.Integer, "2"), (fields["voice.awayMinutes"].Kind, fields["voice.awayMinutes"].Placeholder));

        var dictation = sections[1].Fields.ToDictionary((field) => field.Path);

        Assert.Equal((FieldKind.Integer, "10"), (dictation["voice.micIdleMinutes"].Kind, dictation["voice.micIdleMinutes"].Placeholder));
        Assert.Equal((FieldKind.Integer, "3000"), (dictation["voice.endPauseMs"].Kind, dictation["voice.endPauseMs"].Placeholder));
        Assert.Equal((FieldKind.Text, "System default"), (dictation["voice.inputDevice"].Kind, dictation["voice.inputDevice"].Placeholder));
        Assert.Equal("1.25", SettingsPages.FieldViewOf(fields["voice.speed"], 1.25, []).Text);
    }

    [Fact]
    public void VoiceFields_Assignments_OfferNoneAndTheRosterAndMarkWhatIsMissing()
    {
        var config = WithRoster();

        SettingsConfigs.Value(config)["voice"]!["playbookPersonas"]!["dev:gone"] = "vega";

        var sections = SettingsFields.VoiceFields(State(config));
        var review = FieldOf(sections, "voice.playbookPersonas.dev:review");
        var gone = FieldOf(sections, "voice.playbookPersonas.dev:gone");

        Assert.Equal(("dev:review", FieldKind.Select), (review.Label, review.Kind));
        Assert.Equal([("", "None"), ("nova", "Nova (nova)"), ("orion", "Orion (orion)")], review.Options!.Select((option) => (option.Value, option.Label)));
        Assert.Equal("dev:gone (missing)", gone.Label);
        Assert.Equal("vega (missing)", gone.Options![^1].Label);
    }

    [Fact]
    public void VoiceFields_VoiceNotListed_KeepsItAsMissing()
    {
        var config = SettingsConfigs.Basic().Also((value) => SettingsConfigs.Value(value)["voice"] = new JsonObject { ["voice"] = "nova" });

        Assert.Equal("nova (missing)", FieldOf(SettingsFields.VoiceFields(State(config)), "voice.voice").Options![^1].Label);
    }

    [Fact]
    public void ReadField_Number_ReadsADecimalAndKeepsOtherText()
    {
        Assert.Equal("1.25", SettingsFields.ReadField(FieldKind.Number, " 1.25 ")!.ToJsonString());
        Assert.Equal("1", SettingsFields.ReadField(FieldKind.Number, "1")!.ToJsonString());
        Assert.Null(SettingsFields.ReadField(FieldKind.Number, " "));
        Assert.Equal("\"1,5\"", SettingsFields.ReadField(FieldKind.Number, "1,5")!.ToJsonString());
        Assert.Equal("\"fast\"", SettingsFields.ReadField(FieldKind.Number, "fast")!.ToJsonString());
    }

    [Fact]
    public void GetAtAndSetAt_ListEntryPath_ReadAndWriteOnlyAnExistingEntry()
    {
        var root = SettingsConfigs.Value(WithRoster());

        Assert.Equal("cedar", SettingsFields.GetAt(root, "voice.personas[0].voice")!.GetValue<string>());
        Assert.Null(SettingsFields.GetAt(root, "voice.personas[2].voice"));

        var named = SettingsFields.SetAt(root, "voice.personas[1].name", "Vega");

        Assert.Equal("Vega", named["voice"]!["personas"]![1]!["name"]!.GetValue<string>());
        Assert.Equal("Orion", root["voice"]!["personas"]![1]!["name"]!.GetValue<string>());
        Assert.Equal(root.ToJsonString(), SettingsFields.SetAt(root, "voice.personas[5].name", "Vega").ToJsonString());
        Assert.Null(SettingsFields.SetAt(root, "voice.personas[0].voice", null)["voice"]!["personas"]![0]!["voice"]);
        Assert.Equal(["orion"], SettingsFields.SetAt(root, "voice.personas[0]", null)["voice"]!["personas"]!.AsArray().Select((entry) => entry!["id"]!.GetValue<string>()));
    }

    [Fact]
    public void Page_Voice_PlacesErrorsOnItsFieldsAndKeepsPersonaErrorsOnTheirPages()
    {
        var state = State();

        state.Page = "voice";
        state.Errors =
        [
            "voice.speed must be a number from 0.25 to 1.5.",
            "voice.playbookPersonas.dev:review must name a persona in voice.personas.",
            "voice.personas[1].style must be one of none, pair, upbeat, deadpan or expressive.",
            "voice.mic is not a setting.",
            "voice.endPauseMs must be a whole number from 500 to 20000.",
        ];

        var page = SettingsPages.Page(state);
        var fields = page.Sections.SelectMany((section) => section.Fields).ToDictionary((field) => field.Field.Path);

        Assert.Equal(["voice.speed must be a number from 0.25 to 1.5."], fields["voice.speed"].Errors);
        Assert.Equal(["voice.endPauseMs must be a whole number from 500 to 20000."], fields["voice.endPauseMs"].Errors);
        Assert.Equal(["voice.playbookPersonas.dev:review must name a persona in voice.personas."], fields["voice.playbookPersonas.dev:review"].Errors);
        Assert.Equal(["voice.mic is not a setting."], page.Errors);
        Assert.Equal(["dev:develop"], page.Assign!.Playbooks);
        Assert.Equal(["nova", "orion"], page.Assign.Personas.Select((option) => option.Value));

        state.Page = "general";
        Assert.Empty(SettingsPages.Page(state).Errors);
        Assert.True(SettingsPages.PageHasErrors(state, "persona:1"));
        Assert.False(SettingsPages.PageHasErrors(state, "general"));
    }

    [Fact]
    public void Page_VoiceWithoutPersonas_OffersNoPlaybookToAssign()
    {
        var state = SettingsConfigs.State();

        state.Page = "voice";

        var page = SettingsPages.Page(state);

        Assert.Equal(("Voice", "C:/cfg/settings.json"), (page.Title, page.FilePath));
        Assert.Empty(page.Assign!.Personas);
        Assert.Empty(page.Assign.Playbooks);
    }

    [Fact]
    public void Page_Persona_PlacesItsErrorsOnItsFieldsAndOffersRemove()
    {
        var state = State();

        state.Page = "persona:0";
        state.Errors = ["voice.personas[0].personality must be at most 600 characters.", "voice.personas[0].id nova is used by another persona.", "voice.personas[1].name must be 1 to 40 characters."];

        var page = SettingsPages.Page(state);
        var fields = page.Sections.Single().Fields.ToDictionary((field) => field.Field.Path);

        Assert.Equal("Persona nova", page.Title);
        Assert.Equal(["voice.personas[0].name", "voice.personas[0].voice", "voice.personas[0].style", "voice.personas[0].personality"], fields.Keys);
        Assert.Equal(("Nova", "cedar"), (fields["voice.personas[0].name"].Text, fields["voice.personas[0].voice"].Selected));
        Assert.Equal("Voice setting (Marin)", fields["voice.personas[0].voice"].Field.Options![0].Label);
        Assert.Equal("", fields["voice.personas[0].style"].Selected);
        Assert.Equal(["voice.personas[0].personality must be at most 600 characters."], fields["voice.personas[0].personality"].Errors);
        Assert.Equal(["voice.personas[0].id nova is used by another persona."], page.Errors);
        Assert.Equal(("remove-persona", "0"), (page.Buttons.Single().Command, page.Buttons.Single().Argument));

        state.Page = "persona:7";
        Assert.Equal("This persona no longer exists.", SettingsPages.Page(state).Message);
    }

    [Theory]
    [InlineData(" Cedar ", true)]
    [InlineData("shimmer", true)]
    [InlineData("Cedric", false)]
    public void Page_PersonaNamedLikeAVoice_WarnsToChooseAnotherName(string name, bool warns)
    {
        var state = State();

        state.SetDraft(SettingsFields.SetAt(state.SettingsValue!, "voice.personas[1].name", name));
        state.Page = "persona:1";

        var notes = SettingsPages.Page(state).Notes;

        Assert.Equal(warns ? [$"{name.Trim()} is also the name of an OpenAI voice, which makes the settings hard to read. Choose another name."] : [], notes);
    }

    [Fact]
    public void Page_PersonaNotAnObject_ShowsItsErrorAndRemove()
    {
        var config = WithRoster();

        SettingsConfigs.Value(config)["voice"]!["personas"]!.AsArray().Add("vega");

        var state = State(config);

        state.Page = "persona:2";
        state.Errors = ["voice.personas[2] must be an object."];

        var page = SettingsPages.Page(state);

        Assert.Equal("Fix this entry in settings.json in an editor, or remove it.", page.Message);
        Assert.Equal(["voice.personas[2] must be an object."], page.Errors);
        Assert.Equal("remove-persona", page.Buttons.Single().Command);
        Assert.Equal("Persona 3", SettingsPages.Nav(state).Single((entry) => entry.Argument == "persona:2").Label);

        state.Page = "voice";
        Assert.Empty(SettingsPages.Page(state).Errors);
    }

    [Fact]
    public void PageDirty_PersonaEdited_MarksOnlyThatPersona()
    {
        var state = State();

        state.SetDraft(SettingsFields.SetAt(state.SettingsValue!, "voice.personas[0].personality", "Calm."));

        Assert.True(SettingsPages.PageDirty(state, "persona:0"));
        Assert.False(SettingsPages.PageDirty(state, "persona:1"));
        Assert.False(SettingsPages.PageDirty(state, "voice"));

        state.SetDraft(SettingsFields.SetAt(state.SettingsValue!, "voice.speed", 1.5));

        Assert.True(SettingsPages.PageDirty(state, "voice"));
        Assert.False(SettingsPages.PageDirty(state, "general"));
    }

    [Fact]
    public void Page_NewPersona_ShowsTheIdErrorOnlyOnceTyped()
    {
        var state = State();

        state.Page = "new-persona";
        Assert.Equal((true, null), (SettingsPages.Page(state).NewName!.Persona, SettingsPages.Page(state).NewName!.Error));

        state.NewPersona = ("nova", false);
        Assert.Equal("A persona with the ID nova already exists.", SettingsPages.Page(state).NewName!.Error);

        state.NewPersona = ("Vega", false);
        Assert.Equal("The ID must be lowercase letters, digits and hyphens.", SettingsPages.Page(state).NewName!.Error);

        state.SetDraft(SettingsFields.SetAt(state.SettingsValue!, "voice.personas", "none"));
        state.NewPersona = ("vega", false);
        Assert.Equal("settings.json must hold a voice object with a personas list.", SettingsPages.Page(state).NewName!.Error);
    }

    [Fact]
    public async Task Persona_CreateEditAssignAndRemove_ChangesOnlyTheDraft()
    {
        var editor = await Loaded(SettingsConfigs.Basic());

        editor.Navigate("new-persona");
        editor.Create();
        Assert.Equal("The ID must be lowercase letters, digits and hyphens.", SettingsPages.Page(editor.State!).NewName!.Error);

        editor.EditNewName(null, "vega");
        editor.Create();

        Assert.Equal("persona:0", editor.State!.Page);
        Assert.Equal("""{"personas":[{"id":"vega"}]}""", editor.State.Draft!["voice"]!.ToJsonString());

        var fields = SettingsFields.PersonaFields(editor.State, 0);

        editor.Edit(FieldOf(fields, "voice.personas[0].name"), "Vega");
        editor.Edit(FieldOf(fields, "voice.personas[0].voice"), "sage");
        editor.Edit(FieldOf(fields, "voice.personas[0].voice"), "");
        editor.Edit(FieldOf(fields, "voice.personas[0].personality"), "Brisk.");
        editor.Navigate("voice");
        editor.AssignPersona("dev:develop", "vega");
        editor.AssignPersona("dev:review", "nobody");

        Assert.Equal("""{"personas":[{"id":"vega","name":"Vega","personality":"Brisk."}],"playbookPersonas":{"dev:develop":"vega"}}""", editor.State.Draft!["voice"]!.ToJsonString());
        Assert.Equal(["dev:review"], SettingsPages.Page(editor.State).Assign!.Playbooks);

        editor.RemovePersona(0);

        Assert.Equal("voice", editor.State.Page);
        Assert.Null(editor.State.Draft!["voice"]);
        Assert.False(editor.State.Dirty);
        Assert.Empty(hub.Calls);
    }

    [Fact]
    public async Task Create_PersonaInAFileWithNoVoiceSection_MarksOnlyItsPageDirty()
    {
        var editor = await Loaded(SettingsConfigs.Basic());

        editor.Navigate("new-persona");
        editor.EditNewName(null, "vega");
        editor.Create();

        Assert.True(SettingsPages.PageDirty(editor.State!, "persona:0"));
        Assert.False(SettingsPages.PageDirty(editor.State!, "voice"));
    }

    [Fact]
    public async Task RemovePersona_EarlierEntryWithoutId_StillRemovesItsAssignments()
    {
        var config = WithRoster();

        SettingsConfigs.Value(config)["voice"]!["personas"]!.AsArray().Insert(0, new JsonObject());

        var editor = await Loaded(config);

        editor.RemovePersona(1);

        Assert.Equal("{}", editor.State!.Draft!["voice"]!["playbookPersonas"]!.ToJsonString());
    }

    [Fact]
    public async Task Edit_AssignmentKeyWithADot_ReadsAndRemovesThatKey()
    {
        var config = WithRoster();

        SettingsConfigs.Value(config)["voice"]!["playbookPersonas"]!["dev:old.name"] = "orion";

        var editor = await Loaded(config);
        var field = FieldOf(SettingsFields.VoiceFields(editor.State!), "voice.playbookPersonas.dev:old.name");

        Assert.Equal("orion", SettingsPages.FieldViewOf(field, SettingsFields.GetAt(editor.State!.SettingsValue, field.Path), []).Selected);
        Assert.Equal("voice.playbookPersonas.dev:old.name", SettingsFields.FieldOfError("voice.playbookPersonas.dev:old.name must name a persona in voice.personas.", SettingsFields.AllSettingsPaths(editor.State)));

        editor.Edit(field, "");
        Assert.Equal("""{"dev:review":"nova"}""", editor.State.Draft!["voice"]!["playbookPersonas"]!.ToJsonString());

        editor.RemovePersona(0);
        Assert.Equal("{}", editor.State.Draft!["voice"]!["playbookPersonas"]!.ToJsonString());
    }

    [Fact]
    public async Task Load_PersonaMovedOnDisk_FollowsItsIdOrReturnsToVoice()
    {
        var config = WithRoster();

        SettingsConfigs.Value(config)["voice"]!["personas"]!.AsArray().Add(new JsonObject { ["id"] = "vega", ["name"] = "Vega" });

        var editor = await Loaded(config);

        editor.Navigate("persona:1");
        SettingsConfigs.Value(hub.Config)["voice"]!["personas"]!.AsArray().RemoveAt(0);
        hub.Config["settings"]!["version"] = "v2";
        await editor.Load();
        Assert.Equal("persona:0", editor.State!.Page);

        SettingsConfigs.Value(hub.Config)["voice"]!["personas"]!.AsArray().RemoveAt(0);
        hub.Config["settings"]!["version"] = "v3";
        await editor.Load();
        Assert.Equal("voice", editor.State.Page);
    }

    [Fact]
    public async Task RemovePersona_IdKeptByAnotherEntry_KeepsItsAssignments()
    {
        var config = WithRoster();

        SettingsConfigs.Value(config)["voice"]!["personas"]!.AsArray().Add(new JsonObject { ["id"] = "nova", ["name"] = "Nova Two" });

        var editor = await Loaded(config);

        editor.RemovePersona(2);
        Assert.Equal("nova", editor.State!.Draft!["voice"]!["playbookPersonas"]!["dev:review"]!.GetValue<string>());

        editor.RemovePersona(0);
        Assert.Null(editor.State.Draft!["voice"]!["playbookPersonas"]!["dev:review"]);
        Assert.Equal(["orion"], editor.State.PersonaIds);
    }

    [Fact]
    public async Task Edit_AssignmentSetToNone_RemovesItAndRedraws()
    {
        var editor = await Loaded();
        var redraws = new List<bool>();

        editor.Navigate("voice");
        editor.Changed += redraws.Add;

        var review = FieldOf(SettingsFields.VoiceFields(editor.State!), "voice.playbookPersonas.dev:review");

        editor.Edit(review, "orion");
        editor.Edit(review, "");

        Assert.Equal([false, true], redraws);
        Assert.Equal("{}", editor.State!.Draft!["voice"]!["playbookPersonas"]!.ToJsonString());
    }

    [Fact]
    public async Task Save_VoiceEdits_WritesTheVoiceSection()
    {
        var editor = await Loaded();
        var fields = SettingsFields.VoiceFields(editor.State!);

        editor.Navigate("voice");
        editor.Edit(FieldOf(fields, "voice.speed"), "1.25");
        editor.Edit(FieldOf(fields, "voice.needsYouSound"), "", false);
        editor.Edit(FieldOf(fields, "voice.outputDevice"), "Speakers");
        editor.Edit(FieldOf(fields, "voice.micIdleMinutes"), "0");
        editor.Edit(FieldOf(fields, "voice.endPauseMs"), "2500");
        editor.Edit(FieldOf(fields, "voice.inputDevice"), "Headset");
        editor.Edit(FieldOf(fields, "voice.inputDevice"), "");

        Assert.True(await editor.Save());

        var saved = JsonNode.Parse(Assert.Single(hub.Saves)["save ".Length..])!["value"]!["voice"]!;

        Assert.Equal(1.25, saved["speed"]!.GetValue<double>());
        Assert.False(saved["needsYouSound"]!.GetValue<bool>());
        Assert.Equal("Speakers", saved["outputDevice"]!.GetValue<string>());
        Assert.Equal((0, 2500), (saved["micIdleMinutes"]!.GetValue<int>(), saved["endPauseMs"]!.GetValue<int>()));
        Assert.Null(saved["inputDevice"]);
        Assert.Equal(2, saved["personas"]!.AsArray().Count);
    }

    (SettingsWindow Window, SettingsEditor Editor) Open()
    {
        hub.Config = WithRoster();

        var editor = new SettingsEditor(hub, (_) => Task.CompletedTask);
        var window = new SettingsWindow(editor, new FakeActions(), new DockViewModel(new DockSettings(), _ => { }));

        window.Show();
        editor.Load().GetAwaiter().GetResult();
        Settle();

        return (window, editor);
    }

    static void Settle()
    {
        for (var pass = 0; pass < 5; pass++)
        {
            Dispatcher.UIThread.RunJobs();
        }
    }

    static void Click(Button button)
    {
        button.RaiseEvent(new RoutedEventArgs(Button.ClickEvent));
        Settle();
    }

    static T Named<T>(Window window, string name)
        where T : Control => window.GetVisualDescendants().OfType<T>().Single((control) => control.Name == name);

    static Button Tagged(Window window, string tag) => window.GetVisualDescendants().OfType<Button>().Single((button) => (string?)button.Tag == tag);

    [AvaloniaFact]
    public void Window_VoicePage_EditsSpeedAndAssignsAPersona()
    {
        var (window, editor) = Open();

        Click(window.GetVisualDescendants().OfType<Button>().Single((button) => button.Classes.Contains("nav") && (string?)button.Tag == "voice"));

        var speed = Named<TextBox>(window, "field:voice.speed");

        Assert.Equal(120, speed.Width);
        speed.Text = "1.5";
        Settle();
        Assert.Equal(["dev:develop"], Named<ComboBox>(window, "AssignPlaybook").Items.Cast<string>());
        Named<ComboBox>(window, "AssignPersona").SelectedIndex = 1;
        Click(Tagged(window, "assign"));

        Assert.Equal(1.5, editor.State!.Draft!["voice"]!["speed"]!.GetValue<double>());
        Assert.Equal("orion", editor.State.Draft!["voice"]!["playbookPersonas"]!["dev:develop"]!.GetValue<string>());
        Assert.Equal(2, Named<ComboBox>(window, "field:voice.playbookPersonas.dev:develop").SelectedIndex);
        Assert.Equal("Every task playbook has a persona.", Named<TextBlock>(window, "AssignNote").Text);
    }

    [AvaloniaFact]
    public void Window_NewPersona_CreatesItAndOpensItsPage()
    {
        var (window, editor) = Open();

        Click(window.GetVisualDescendants().OfType<Button>().Single((button) => button.Classes.Contains("nav") && (string?)button.Tag == "new-persona"));
        Named<TextBox>(window, "NewName").Text = "vega";
        Settle();
        Click(Tagged(window, "create"));

        Assert.Equal("persona:2", editor.State!.Page);
        Named<TextBox>(window, "field:voice.personas[2].name").Text = "Sage";
        Settle();
        Assert.Contains(window.GetVisualDescendants().OfType<TextBlock>(), (text) => text.Text == "Sage is also the name of an OpenAI voice, which makes the settings hard to read. Choose another name.");
        Named<TextBox>(window, "field:voice.personas[2].name").Text = "Vega";
        Settle();
        Assert.DoesNotContain(window.GetVisualDescendants().OfType<TextBlock>(), (text) => text.Text?.Contains("OpenAI voice", StringComparison.Ordinal) == true);
        Assert.Contains(window.GetVisualDescendants().OfType<Button>(), (button) => button.Classes.Contains("nav") && (string?)button.Tag == "persona:2" && button.GetVisualDescendants().OfType<TextBlock>().Any((text) => text.Text == "Vega"));

        Click(Tagged(window, "remove-persona"));

        Assert.Equal("voice", editor.State.Page);
        Assert.Equal(2, editor.State.PersonaCount);
    }
}
